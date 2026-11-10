import { report } from "@punyts/core";
import { createStore, type Store } from "@punyts/state";
import { applyChange, copyJson } from "./Apply.js";
import type { LocalChange, StoreBridge, SyncState } from "./Bridge.js";
import type { Change, JsonValue } from "./Change.js";
import {
    PROTOCOL_VERSION,
    REVOKED_CODE,
    type AckMessage,
    type ChangesMessage,
    type SyncMessage,
    type WelcomeMessage
} from "./Messages.js";
import { SERVER_PATH, isAtOrBelow, isSyncPath } from "./Paths.js";
import { forgetNamespace, type LocalStore } from "./LocalStore.js";
import type { SyncTransport, TransportConnection } from "./Transport.js";
import { parseMessage, type SyncLimits } from "./Validate.js";

/** standalone: no authority, the local store is the authority */
export type SyncStatus = "standalone" | "connecting" | "online" | "offline";

export interface SyncStatusReport {
    status: SyncStatus;
    /** The changes in the outbox: not yet acknowledged by the authority */
    waiting: number;
    /** The last write to the local store failed (a quota error); the state is kept in memory */
    saveFailed: boolean;
}

export interface SyncRejection {
    path: string;
    reason: string;
}

/** What the client keeps between runs: the confirmed state, its revision and the outbox */
export interface SyncClientState {
    state: SyncState;
    revision: number;
    outbox: Change[];
}

export interface SyncClientOptions {
    namespace: string;
    bridge: StoreBridge;
    /** The connection to the authority; without one the client is standalone */
    transport?: SyncTransport;
    /** Keeps the confirmed state, its revision and the outbox across reloads */
    localStore?: LocalStore;
    /** crypto.randomUUID by default */
    clientId?: string;
    /** Mounted into the visible store on start, before any connection, when the local store holds nothing */
    initial?: SyncClientState;
    limits?: Partial<SyncLimits>;
    /** The wait before reconnect attempt n (0 first); 500 ms doubling to 30 s by default */
    backoff?: (attempt: number) => number;
    onStatus?: (report: SyncStatusReport) => void;
    /** The authority refused a change; its path shows the confirmed value again */
    onRejected?: (rejection: SyncRejection) => void;
    onEmit?: (name: string, value?: JsonValue) => void;
    /**
     * The authority sent the error `revoked`: this client may no longer have the namespace. Before this is called the
     * client has stopped for good (no reconnect, no save, `start` does nothing) and deleted every part of the namespace
     * from the local store, the host's document included. The visible store still shows the last state, for the host
     * to clear
     */
    onRevoked?: (message: string) => void;
}

export interface SyncClient {
    /** Mounts the initial state, starts capturing and connects */
    start: () => void;
    /** Closes the connection and stops capturing and reconnecting */
    stop: () => void;
    status: () => SyncStatusReport;
    /** A copy of the confirmed state, its revision and the outbox */
    state: () => SyncClientState;
    /** Sends a named event to the authority; false when not online */
    emit: (name: string, value?: JsonValue) => boolean;
}

interface OutboxEntry {
    change: Change;
    /** Sent on the current connection and waiting for its ack */
    sent: boolean;
}

const defaultBackoff = (attempt: number) => Math.min(30_000, 500 * 2 ** attempt);

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const isConfirmedPart = (value: unknown): value is { state: SyncState; revision: number } =>
    isRecord(value) &&
    isRecord(value.state) &&
    typeof value.revision === "number" &&
    Number.isInteger(value.revision) &&
    value.revision >= 0;

/**
 * The client side of state sync. It keeps the confirmed state (the authority's state at its revision) and an ordered
 * outbox of the store's own changes; the visible store is the confirmed state with the outbox on top. Changes from the
 * authority are written through the bridge, tagged, so they are not sent back.
 * @param options
 */
export const createSyncClient = (options: SyncClientOptions): SyncClient => {
    const { namespace, bridge, transport, localStore } = options;
    const clientId = options.clientId ?? globalThis.crypto.randomUUID();
    const backoff = options.backoff ?? defaultBackoff;

    let confirmed: Store<any> = createStore({});
    let revision = 0;
    let outbox: OutboxEntry[] = [];

    //the parts changed since the last write to the local store
    const dirty = { confirmed: false, outbox: false };
    let saveScheduled = false;
    let saveFailed = false;

    let running = false;
    //the namespace was revoked: the client never runs again
    let revoked = false;
    let connection: TransportConnection | undefined;
    //the handlers of a connection act only while it is the current one
    let current: object | undefined;
    //false until the authority's welcome on the current connection; changes and acks wait for it
    let welcomed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    let status: SyncStatus = "offline";
    let lastReport: SyncStatusReport = { status, waiting: 0, saveFailed };

    const currentReport = (): SyncStatusReport => ({ status, waiting: outbox.length, saveFailed });

    const reportStatus = () => {
        const next = currentReport();
        if (next.status !== lastReport.status || next.waiting !== lastReport.waiting || next.saveFailed !== lastReport.saveFailed) {
            lastReport = next;
            options.onStatus?.({ ...next });
        }
    };

    const setStatus = (next: SyncStatus) => {
        status = next;
        reportStatus();
    };

    /**
     * Writes the changed parts to the local store, confirmed before outbox: a stop between them leaves a confirmed
     * change also in the outbox, where it is applied again (changes are idempotent) and acked again by its id
     */
    const save = () => {
        saveScheduled = false;
        if (!localStore) {
            return;
        }
        const parts: [keyof typeof dirty, () => JsonValue][] = [
            ["confirmed", () => ({ state: copyJson(confirmed.get("$")), revision })],
            ["outbox", () => outbox.map(({ change }) => copyJson(change))]
        ];
        let failed = false;
        for (const [part, value] of parts) {
            if (!dirty[part]) {
                continue;
            }
            dirty[part] = false;
            try {
                localStore.write(namespace, part, value());
            }
            catch (error) {
                failed = true;
                report("state-sync", "Could not save the %s of %s: %s", [part, namespace, error instanceof Error ? error.name : String(error)]);
                //the next save tries the part again
                dirty[part] = true;
                break;
            }
        }
        saveFailed = failed;
        reportStatus();
    };

    const markDirty = (part: keyof typeof dirty) => {
        if (!localStore) {
            return;
        }
        dirty[part] = true;
        if (!saveScheduled) {
            saveScheduled = true;
            queueMicrotask(() => {
                if (saveScheduled) {
                    save();
                }
            });
        }
    };

    /**
     * The visible value of a path: the confirmed value with the outbox changes at, above or below it applied, on a copy
     * of the subtree under the highest of them
     */
    const visibleValue = (path: string): JsonValue | undefined => {
        const related = outbox.filter(({ change }) => isAtOrBelow(change.path, path) || isAtOrBelow(path, change.path));
        if (related.length === 0) {
            return copyJson(confirmed.get(path));
        }
        let root = path;
        for (const { change } of related) {
            if (isAtOrBelow(root, change.path)) {
                root = change.path;
            }
        }
        const start = copyJson(confirmed.get(root));
        const scratch = createStore<any>(start === undefined ? {} : { root: start });
        const move = (moved: string) => `$.root${moved.slice(root.length)}`;
        for (const { change } of related) {
            applyChange(scratch, { ...change, path: move(change.path) });
        }
        return copyJson(scratch.get(move(path)));
    };

    const visibleState = (): SyncState => {
        const scratch = createStore<any>(copyJson(confirmed.get("$")));
        for (const { change } of outbox) {
            applyChange(scratch, change);
        }
        return copyJson(scratch.get("$"));
    };

    const refresh = (path: string) => bridge.write(path, visibleValue(path));

    const removeFromOutbox = (id: string): OutboxEntry | undefined => {
        const index = outbox.findIndex(({ change }) => change.id === id);
        if (index < 0) {
            return undefined;
        }
        markDirty("outbox");
        return outbox.splice(index, 1)[0];
    };

    const send = (message: SyncMessage) => connection?.send(JSON.stringify(message));

    const sendHello = () => {
        welcomed = false;
        for (const entry of outbox) {
            entry.sent = false;
        }
        setStatus("connecting");
        send({ type: "hello", namespace, revision, clientId, protocol: PROTOCOL_VERSION });
    };

    const sendOutbox = () => {
        for (const entry of outbox) {
            if (!entry.sent) {
                send({ type: "change", change: entry.change });
                entry.sent = true;
            }
        }
    };

    const closeConnection = () => {
        const closing = connection;
        connection = undefined;
        current = undefined;
        welcomed = false;
        closing?.close();
    };

    const scheduleReconnect = () => {
        if (!running) {
            return;
        }
        const delay = backoff(attempt++);
        timer = setTimeout(() => {
            timer = undefined;
            connect();
        }, delay);
    };

    const dropped = () => {
        closeConnection();
        for (const entry of outbox) {
            entry.sent = false;
        }
        setStatus("offline");
        scheduleReconnect();
    };

    const onWelcome = (message: WelcomeMessage) => {
        if (message.namespace !== namespace) {
            report("state-sync", "Closing the connection: welcome for namespace %s, expected %s", [message.namespace, namespace]);
            dropped();
            return;
        }
        if (message.snapshot !== undefined) {
            //an outbox change the authority already applied is resent; the authority acks it again by its id
            confirmed = createStore(copyJson(message.snapshot));
        }
        else {
            for (const change of message.changes ?? []) {
                if (change.revision > revision) {
                    applyChange(confirmed, change);
                    revision = change.revision;
                }
                //an outbox change that reached the authority before the connection dropped is confirmed now
                removeFromOutbox(change.id);
            }
        }
        revision = message.revision;
        markDirty("confirmed");
        bridge.load(visibleState());
        welcomed = true;
        attempt = 0;
        setStatus("online");
        sendOutbox();
    };

    /** A revision was skipped: ask for a catch-up again */
    const resync = () => {
        report("state-sync", "Revision gap in %s at %s, catching up again", [namespace, revision]);
        sendHello();
    };

    const onChanges = (message: ChangesMessage) => {
        for (const change of message.changes) {
            if (change.revision <= revision) {
                continue;
            }
            if (change.revision !== revision + 1) {
                resync();
                return;
            }
            applyChange(confirmed, change);
            revision = change.revision;
            markDirty("confirmed");
            removeFromOutbox(change.id);
            refresh(change.path);
        }
        reportStatus();
    };

    const onAck = (message: AckMessage) => {
        const entry = removeFromOutbox(message.id);
        if (!entry) {
            return;
        }
        const { path } = entry.change;
        if (message.result === "rejected") {
            refresh(path);
            reportStatus();
            options.onRejected?.({ path, reason: message.reason ?? "" });
            return;
        }
        const ackRevision = message.revision ?? 0;
        if (ackRevision <= revision) {
            //already in the confirmed state through a catch-up
            reportStatus();
            return;
        }
        if (ackRevision !== revision + 1) {
            reportStatus();
            resync();
            return;
        }
        if (message.result === "applied") {
            applyChange(confirmed, entry.change);
        }
        else {
            applyChange(confirmed, { path, op: "set", value: message.value });
            refresh(path);
        }
        revision = ackRevision;
        markDirty("confirmed");
        reportStatus();
    };

    const receive = (text: string) => {
        const parsed = parseMessage(text, options.limits);
        if (!parsed.ok) {
            report("state-sync", "Ignoring a message from the authority: %s", [parsed.error.message]);
            return;
        }
        const message = parsed.message;
        switch (message.type) {
            case "welcome":
                onWelcome(message);
                return;
            case "changes":
                if (welcomed) {
                    onChanges(message);
                }
                return;
            case "ack":
                if (welcomed) {
                    onAck(message);
                }
                return;
            case "emit":
                options.onEmit?.(message.name, message.value);
                return;
            case "error":
                if (message.code === REVOKED_CODE) {
                    revoke(message.message);
                    return;
                }
                report("state-sync", "The authority sent an error: %s %s", [message.code, message.message]);
                return;
            default:
                report("state-sync", "Ignoring a %s message from the authority", [message.type]);
        }
    };

    /** Stops for good and deletes what the local store keeps of the namespace, the outbox included */
    const revoke = (text: string) => {
        if (revoked) {
            return;
        }
        revoked = true;
        running = false;
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
        unsubscribe?.();
        unsubscribe = undefined;
        closeConnection();
        saveScheduled = false;
        dirty.confirmed = false;
        dirty.outbox = false;
        outbox = [];
        if (localStore) {
            forgetNamespace(localStore, namespace);
        }
        setStatus("offline");
        options.onRevoked?.(text);
    };

    const connect = () => {
        if (!transport) {
            return;
        }
        const token = {};
        current = token;
        //a reconnect stays offline until the connection opens
        try {
            connection = transport.connect({
                onOpen: () => {
                    if (current === token) {
                        sendHello();
                    }
                },
                onMessage: (text) => {
                    if (current === token) {
                        receive(text);
                    }
                },
                onClose: () => {
                    if (current === token) {
                        dropped();
                    }
                }
            });
        }
        catch (error) {
            report("state-sync", "Could not connect: %s", [error instanceof Error ? error.message : String(error)]);
            dropped();
        }
    };

    const enqueue = (changes: LocalChange[]) => {
        for (const local of changes) {
            if (!isSyncPath(local.path) || isAtOrBelow(local.path, SERVER_PATH)) {
                continue;
            }
            if (!transport) {
                //standalone: the local store is the authority, so a change is confirmed at once
                applyChange(confirmed, local);
                markDirty("confirmed");
                continue;
            }
            const change: Change = { ...local, base: revision };
            //only changes not yet sent fold: every sent change gets its ack. A merge covers nothing below it.
            if (change.op !== "merge") {
                outbox = outbox.filter((entry) => entry.sent || !isAtOrBelow(entry.change.path, change.path));
            }
            outbox.push({ change, sent: false });
            markDirty("outbox");
        }
        if (welcomed) {
            sendOutbox();
        }
        reportStatus();
    };

    /** What the local store holds for the namespace; a part that cannot be read, or a change in it, is skipped */
    const restore = (): SyncClientState | undefined => {
        if (!localStore) {
            return undefined;
        }
        const stored = localStore.read(namespace, "confirmed");
        if (!isConfirmedPart(stored)) {
            if (stored !== undefined) {
                report("state-sync", "Ignoring the saved state of %s: it is not a state and revision", [namespace]);
            }
            return undefined;
        }
        const savedOutbox = localStore.read(namespace, "outbox");
        const changes: Change[] = [];
        for (const change of Array.isArray(savedOutbox) ? savedOutbox : []) {
            const parsed = parseMessage({ type: "change", change }, options.limits);
            if (parsed.ok && parsed.message.type === "change") {
                changes.push(parsed.message.change);
            }
            else {
                report("state-sync", "Ignoring a saved change of %s that is not valid", [namespace]);
            }
        }
        return { state: stored.state, revision: stored.revision, outbox: changes };
    };

    const mount = (mounted: SyncClientState) => {
        confirmed = createStore(copyJson(mounted.state));
        revision = mounted.revision;
        outbox = mounted.outbox.map((change) => ({ change: copyJson<Change>(change), sent: false }));
        if (!transport && outbox.length > 0) {
            //a standalone client confirms what a connected run left waiting
            for (const { change } of outbox) {
                applyChange(confirmed, change);
            }
            outbox = [];
            markDirty("confirmed");
            markDirty("outbox");
        }
    };

    return {
        start: () => {
            if (running || revoked) {
                return;
            }
            running = true;
            const mounted = restore() ?? options.initial;
            if (mounted) {
                mount(mounted);
                bridge.load(visibleState());
            }
            unsubscribe = bridge.subscribe(enqueue);
            if (!transport) {
                setStatus("standalone");
                return;
            }
            setStatus("connecting");
            connect();
        },
        stop: () => {
            running = false;
            if (timer !== undefined) {
                clearTimeout(timer);
                timer = undefined;
            }
            unsubscribe?.();
            unsubscribe = undefined;
            closeConnection();
            if (saveScheduled && !revoked) {
                save();
            }
            setStatus(transport ? "offline" : "standalone");
        },
        status: currentReport,
        state: () => ({
            state: copyJson(confirmed.get("$")),
            revision,
            outbox: outbox.map(({ change }) => copyJson<Change>(change))
        }),
        emit: (name, value) => {
            if (!welcomed) {
                return false;
            }
            send(value === undefined ? { type: "emit", name } : { type: "emit", name, value });
            return true;
        }
    };
};

import { report } from "@punyts/core";
import { createStore, type Store } from "@punyts/state";
import { applyChange, copyJson } from "./Apply.js";
import type { LocalChange, StoreBridge, SyncState } from "./Bridge.js";
import type { Change, JsonValue } from "./Change.js";
import {
    PROTOCOL_VERSION,
    type AckMessage,
    type ChangesMessage,
    type SyncMessage,
    type WelcomeMessage
} from "./Messages.js";
import { SERVER_PATH, isAtOrBelow, isSyncPath } from "./Paths.js";
import type { SyncTransport, TransportConnection } from "./Transport.js";
import { parseMessage, type SyncLimits } from "./Validate.js";

export type SyncStatus = "connecting" | "online" | "offline";

export interface SyncStatusReport {
    status: SyncStatus;
    /** The changes in the outbox: not yet acknowledged by the authority */
    waiting: number;
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
    transport: SyncTransport;
    /** crypto.randomUUID by default */
    clientId?: string;
    /** Mounted into the visible store on start, before any connection */
    initial?: SyncClientState;
    limits?: Partial<SyncLimits>;
    /** The wait before reconnect attempt n (0 first); 500 ms doubling to 30 s by default */
    backoff?: (attempt: number) => number;
    onStatus?: (report: SyncStatusReport) => void;
    /** The authority refused a change; its path shows the confirmed value again */
    onRejected?: (rejection: SyncRejection) => void;
    onEmit?: (name: string, value?: JsonValue) => void;
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

/**
 * The client side of state sync. It keeps the confirmed state (the authority's state at its revision) and an ordered
 * outbox of the store's own changes; the visible store is the confirmed state with the outbox on top. Changes from the
 * authority are written through the bridge, tagged, so they are not sent back.
 * @param options
 */
export const createSyncClient = (options: SyncClientOptions): SyncClient => {
    const { namespace, bridge, transport } = options;
    const clientId = options.clientId ?? globalThis.crypto.randomUUID();
    const backoff = options.backoff ?? defaultBackoff;

    let confirmed: Store<any> = createStore({});
    let revision = 0;
    let outbox: OutboxEntry[] = [];

    let running = false;
    let connection: TransportConnection | undefined;
    //the handlers of a connection act only while it is the current one
    let current: object | undefined;
    //false until the authority's welcome on the current connection; changes and acks wait for it
    let welcomed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    let lastReport: SyncStatusReport = { status: "offline", waiting: 0 };
    let status: SyncStatus = "offline";

    const reportStatus = () => {
        const next = { status, waiting: outbox.length };
        if (next.status !== lastReport.status || next.waiting !== lastReport.waiting) {
            lastReport = next;
            options.onStatus?.({ ...next });
        }
    };

    const setStatus = (next: SyncStatus) => {
        status = next;
        reportStatus();
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
        return index < 0 ? undefined : outbox.splice(index, 1)[0];
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
                report("state-sync", "The authority sent an error: %s %s", [message.code, message.message]);
                return;
            default:
                report("state-sync", "Ignoring a %s message from the authority", [message.type]);
        }
    };

    const connect = () => {
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
            const change: Change = { ...local, base: revision };
            //only changes not yet sent fold: every sent change gets its ack. A merge covers nothing below it.
            if (change.op !== "merge") {
                outbox = outbox.filter((entry) => entry.sent || !isAtOrBelow(entry.change.path, change.path));
            }
            outbox.push({ change, sent: false });
        }
        if (welcomed) {
            sendOutbox();
        }
        reportStatus();
    };

    return {
        start: () => {
            if (running) {
                return;
            }
            running = true;
            if (options.initial) {
                confirmed = createStore(copyJson(options.initial.state));
                revision = options.initial.revision;
                outbox = options.initial.outbox.map((change) => ({ change: copyJson<Change>(change), sent: false }));
                bridge.load(visibleState());
            }
            unsubscribe = bridge.subscribe(enqueue);
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
            setStatus("offline");
        },
        status: () => ({ status, waiting: outbox.length }),
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

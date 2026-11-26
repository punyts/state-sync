import { isReported, report } from "@punyts/core";
import { compilePattern, createStore, patternCovers, type PathPattern, type Store } from "@punyts/state";
import { applyChange, copyJson } from "./Apply.js";
import type { LocalChange, StoreBridge, SyncState } from "./Bridge.js";
import type { Change, JsonValue } from "./Change.js";
import { randomId } from "./RandomId.js";
import {
    PROTOCOL_VERSION,
    REVOKED_CODE,
    type AckMessage,
    type ChangesMessage,
    type DecidedMessage,
    type RejectionCode,
    type SyncMessage,
    type SyncRequest,
    type WelcomeMessage
} from "./Messages.js";
import { SERVER_PATH, isAtOrBelow, isSyncPath } from "./Paths.js";
import { forgetNamespace, type LocalStore } from "./LocalStore.js";
import type { SyncTransport, TransportConnection } from "./Transport.js";
import { parseMessage, type SyncLimits } from "./Validate.js";
import { createSyncWire, type SyncWire } from "./Wire.js";

/** standalone: no authority, the local store is the authority */
export type SyncStatus = "standalone" | "connecting" | "online" | "offline";

export interface SyncStatusReport {
    status: SyncStatus;
    /** The changes in the outbox: not yet acknowledged by the authority */
    waiting: number;
    /**
     * This client's changes the authority applied that are not durable yet: shown, but pending until the
     * watermark passes them, when they are committed
     */
    pending: number;
    /** The last write to the local store failed (a quota error); the state is kept in memory */
    saveFailed: boolean;
}

export interface SyncRejection {
    path: string;
    reason: string;
    /** The kind of refusal, when the authority gave one */
    code?: RejectionCode;
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
    /** randomId by default */
    clientId?: string;
    /** Mounted into the visible store on start, before any connection, when the local store holds nothing */
    initial?: SyncClientState;
    limits?: Partial<SyncLimits>;
    /** The wait before reconnect attempt n (0 first); 500 ms doubling to 30 s by default */
    backoff?: (attempt: number) => number;
    onStatus?: (report: SyncStatusReport) => void;
    /** The authority refused a change; its path shows the confirmed value again */
    onRejected?: (rejection: SyncRejection) => void;
    /**
     * The requests the client knows changed (docs/design/statenet-requests.md): its own, sent by changes the
     * authority keeps for a decision, and those it may decide; each as it is now, the decided ones too
     */
    onRequests?: (requests: readonly SyncRequest[]) => void;
    onEmit?: (name: string, value?: JsonValue) => void;
    /** The durable watermark moved: every change up to `revision` is committed, with the ids of this client's changes it committed */
    onDurable?: (revision: number, committed: readonly string[]) => void;
    /**
     * The authority sent the error `revoked`: this client may no longer have the namespace. Before this is called the
     * client has stopped for good (no reconnect, no save, `start` does nothing) and deleted every part of the namespace
     * from the local store, the host's document included. The visible store still shows the last state, for the host
     * to clear
     */
    onRevoked?: (message: string) => void;
    /**
     * Paths that stay on the device ("$."-prefixed, "*" matching one segment; a node's `@local`): a change at or below
     * one is never sent. It is kept in the local store's `local` part and laid over the confirmed state and outbox
     */
    local?: readonly string[];
    /**
     * Paths that go to the authority only (a node's `@secret`): a change at or below one is sent while online and
     * dropped while offline, never written to the local store and never kept in the confirmed state, so it stays only in
     * the visible store until the page closes
     */
    secret?: readonly string[];
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
    /** How far the namespace is durable, as the authority last said; 0 before it says */
    durable: () => number;
    /** Copies of the requests the client knows, in the order it learned them */
    requests: () => SyncRequest[];
    /** Approves a request this client may decide; false when not online. The authority answers with `decided` */
    approve: (id: string) => boolean;
    /** Rejects a request this client may decide, with a note for its requester; false when not online */
    reject: (id: string, note?: string) => boolean;
    /** Takes back a pending request of this client's; false when not online */
    withdraw: (id: string) => boolean;
    /**
     * Replaces the local and secret paths (`SyncClientOptions.local`, `.secret`), for a host that learns them from a
     * document after the client started; a kind left out stays as it is. Kept local changes no longer at a local path
     * are forgotten
     */
    setPaths: (paths: { local?: readonly string[]; secret?: readonly string[] }) => void;
    /** Asks the authority to undo the newest change of the namespace's history; false when not online */
    undo: () => boolean;
    /** Asks the authority to write the newest undone change again; false when not online */
    redo: () => boolean;
}

interface OutboxEntry {
    change: Change;
    /** Sent on the current connection and waiting for its ack */
    sent: boolean;
    /** At a secret path: never saved, and dropped when the connection closes */
    secret?: true;
}

/** Compiles path patterns; a text that is not one throws */
const patternsOf = (sources: readonly string[] | undefined): PathPattern[] =>
    (sources ?? []).map((source) => {
        const pattern = compilePattern(source);
        if (pattern === undefined) {
            throw new Error(`${source} is not a path pattern`);
        }
        return pattern;
    });

/** The category of the sync client's reports: namespaces, revisions, paths and counts, never values */
const CATEGORY = "state-sync.client";

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
    const clientId = options.clientId ?? randomId();
    const backoff = options.backoff ?? defaultBackoff;
    let localPatterns = patternsOf(options.local);
    let secretPatterns = patternsOf(options.secret);
    const isLocal = (path: string) => localPatterns.some((pattern) => patternCovers(pattern, path));
    const isSecret = (path: string) => secretPatterns.some((pattern) => patternCovers(pattern, path));

    let confirmed: Store<any> = createStore({});
    let revision = 0;
    let outbox: OutboxEntry[] = [];
    //the device's own changes at local paths, in order, one per path: laid over everything, never sent
    let locals: LocalChange[] = [];
    //the requests the authority told this client of, by id
    let requests = new Map<string, SyncRequest>();

    //the parts changed since the last write to the local store
    const dirty = { confirmed: false, outbox: false, local: false };
    let saveScheduled = false;
    let saveFailed = false;

    let running = false;
    //the namespace was revoked: the client never runs again
    let revoked = false;
    let wire: SyncWire | undefined;
    let connection: TransportConnection | undefined;
    //the handlers of a connection act only while it is the current one
    let current: object | undefined;
    //false until the authority's welcome on the current connection; changes and acks wait for it
    let welcomed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: (() => void) | undefined;
    let status: SyncStatus = "offline";
    let lastReport: SyncStatusReport = { status, waiting: 0, pending: 0, saveFailed };
    let durable = 0;
    //the authority sends a watermark (its welcome had one): until then nothing is counted pending
    let watermarked = false;
    //this client's changes the authority applied, by id, with their revision, until the watermark passes them
    const uncommitted = new Map<string, number>();

    const currentReport = (): SyncStatusReport => ({ status, waiting: outbox.length, pending: uncommitted.size, saveFailed });

    /** Takes the authority's watermark: the changes up to it are committed */
    const onDurableRevision = (to: number) => {
        if (to < durable) {
            return;
        }
        durable = to;
        const committed: string[] = [];
        for (const [id, at] of uncommitted) {
            if (at <= to) {
                uncommitted.delete(id);
                committed.push(id);
            }
        }
        reportStatus();
        options.onDurable?.(to, committed);
    };

    const reportStatus = () => {
        const next = currentReport();
        if (next.status !== lastReport.status || next.waiting !== lastReport.waiting || next.pending !== lastReport.pending || next.saveFailed !== lastReport.saveFailed) {
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
            ["outbox", () => outbox.filter((entry) => entry.secret !== true).map(({ change }) => copyJson(change))],
            ["local", () => copyJson<JsonValue>(locals as unknown as JsonValue)]
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
                report(CATEGORY, "Could not save the %s of %s: %s", [part, namespace, error instanceof Error ? error.name : String(error)]);
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
        for (const change of locals) {
            try {
                applyChange(scratch, change);
            }
            catch {
                //its parent is gone from the shared state: it shows again when the parent does
            }
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

    const send = (message: SyncMessage) => {
        if (connection !== undefined && wire !== undefined) connection.send(wire.write(message));
    };

    const sendHello = () => {
        welcomed = false;
        for (const entry of outbox) {
            entry.sent = false;
        }
        setStatus("connecting");
        report(CATEGORY, "Sent hello for %s at revision %s with %s changes waiting", [namespace, revision, outbox.length]);
        send({ type: "hello", namespace, revision, clientId, protocol: PROTOCOL_VERSION });
    };

    const sendOutbox = () => {
        const sent: string[] = [];
        for (const entry of outbox) {
            if (!entry.sent) {
                send({ type: "change", change: entry.change });
                entry.sent = true;
                sent.push(entry.change.path);
            }
        }
        if (sent.length > 0 && isReported(CATEGORY)) {
            report(CATEGORY, "Sent %s changes of %s: %s", [sent.length, namespace, sent.join(", ")]);
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
        report(CATEGORY, "Reconnecting to the authority of %s in %s ms (attempt %s)", [namespace, delay, attempt]);
        timer = setTimeout(() => {
            timer = undefined;
            connect();
        }, delay);
    };

    const dropped = () => {
        report(CATEGORY, "The connection to the authority of %s closed", [namespace]);
        closeConnection();
        //a secret goes to the authority only while online: what was not acked is not sent again
        outbox = outbox.filter((entry) => entry.secret !== true);
        for (const entry of outbox) {
            entry.sent = false;
        }
        setStatus("offline");
        scheduleReconnect();
    };

    const onWelcome = (message: WelcomeMessage) => {
        if (message.namespace !== namespace) {
            report(CATEGORY, "Closing the connection: welcome for namespace %s, expected %s", [message.namespace, namespace]);
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
        const caughtUp = message.snapshot !== undefined ? "a snapshot" : `${message.changes?.length ?? 0} changes`;
        report(CATEGORY, "Welcomed to %s at revision %s with %s, %s changes waiting", [namespace, message.revision, caughtUp, outbox.length]);
        revision = message.revision;
        markDirty("confirmed");
        bridge.load(visibleState());
        welcomed = true;
        if (message.requests !== undefined || requests.size > 0) {
            requests = new Map((message.requests ?? []).map((request) => [request.id, request]));
            requestsChanged();
        }
        attempt = 0;
        setStatus("online");
        sendOutbox();
        watermarked = message.durable !== undefined;
        if (!watermarked) {
            uncommitted.clear();
        }
        if (message.durable !== undefined) {
            onDurableRevision(message.durable);
        }
    };

    /** A revision was skipped: ask for a catch-up again */
    const resync = () => {
        report(CATEGORY, "Revision gap in %s at %s, catching up again", [namespace, revision]);
        sendHello();
    };

    const onChanges = (message: ChangesMessage) => {
        if (isReported(CATEGORY)) {
            report(CATEGORY, "Applying %s changes to %s: %s", [message.changes.length, namespace, message.changes.map((change) => `${change.path}@${change.revision}`).join(", ")]);
        }
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

    const requestsChanged = () => options.onRequests?.([...requests.values()].map((request) => copyJson<SyncRequest>(request)));

    const onDecided = (message: DecidedMessage) => {
        const request = requests.get(message.id);
        if (request === undefined) {
            return;
        }
        requests.set(message.id, {
            ...request,
            status: message.status,
            decidedAt: message.decidedAt,
            ...(message.code === undefined ? {} : { code: message.code }),
            ...(message.note === undefined ? {} : { note: message.note })
        });
        report(CATEGORY, "Request %s of %s was %s", [message.id, namespace, message.status]);
        requestsChanged();
    };

    const onAck = (message: AckMessage) => {
        const entry = removeFromOutbox(message.id);
        if (!entry) {
            return;
        }
        const { path } = entry.change;
        if (isReported(CATEGORY)) {
            report(CATEGORY, "The authority %s the change of %s at %s", [message.result, namespace, path]);
        }
        if (message.result === "passed" || entry.secret === true) {
            //a secret went to server logic only: the confirmed state never holds it, even from an authority that took a revision for it
            if (message.revision === revision + 1) {
                revision = message.revision;
                markDirty("confirmed");
            }
            reportStatus();
            return;
        }
        if (message.result === "requested") {
            //kept as a request (sent as `requested`), so the shared state shows only what the owner applied
            refresh(path);
            reportStatus();
            return;
        }
        if (message.result === "rejected") {
            refresh(path);
            reportStatus();
            options.onRejected?.({ path, reason: message.reason ?? "", ...(message.code === undefined ? {} : { code: message.code }) });
            return;
        }
        const ackRevision = message.revision ?? 0;
        if (watermarked && ackRevision > durable) {
            uncommitted.set(message.id, ackRevision);
        }
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

    const receive = (data: string | Uint8Array) => {
        const parsed = wire === undefined ? undefined : wire.read(data);
        if (parsed === undefined) {
            return;
        }
        if (!parsed.ok) {
            report(CATEGORY, "Ignoring a message from the authority: %s", [parsed.error.message]);
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
            case "durable":
                if (welcomed) {
                    onDurableRevision(message.revision);
                }
                return;
            case "emit":
                options.onEmit?.(message.name, message.value);
                return;
            case "requested":
                if (welcomed) {
                    requests.set(message.request.id, message.request);
                    requestsChanged();
                }
                return;
            case "decided":
                if (welcomed) {
                    onDecided(message);
                }
                return;
            case "error":
                if (message.code === REVOKED_CODE) {
                    revoke(message.message);
                    return;
                }
                report(CATEGORY, "The authority sent an error: %s %s", [message.code, message.message]);
                return;
            default:
                report(CATEGORY, "Ignoring a %s message from the authority", [message.type]);
        }
    };

    /** Sends a decision on a request; false when not online */
    /** Sends undo or redo when online; the result arrives as changes */
    const travel = (type: "undo" | "redo"): boolean => {
        if (!welcomed) {
            return false;
        }
        send({ type });
        return true;
    };

    const decide = (message: SyncMessage & { type: "approve" | "reject" | "withdraw" }): boolean => {
        if (!welcomed) {
            return false;
        }
        send(message);
        return true;
    };

    /** Stops for good and deletes what the local store keeps of the namespace, the outbox included */
    const revoke = (text: string) => {
        if (revoked) {
            return;
        }
        revoked = true;
        running = false;
        report(CATEGORY, "Access to %s was revoked: stopped and forgot it", [namespace]);
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
        requests = new Map();
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
        //each connection numbers its paths afresh
        wire = createSyncWire(options.limits);
        report(CATEGORY, "Connecting to the authority of %s", [namespace]);
        //a reconnect stays offline until the connection opens
        try {
            connection = transport.connect({
                onOpen: () => {
                    if (current === token) {
                        sendHello();
                    }
                },
                onMessage: (data) => {
                    if (current === token) {
                        receive(data);
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
            report(CATEGORY, "Could not connect to the authority of %s: %s", [namespace, error instanceof Error ? error.name : String(error)]);
            dropped();
        }
    };

    const enqueue = (changes: LocalChange[]) => {
        if (isReported(CATEGORY)) {
            report(CATEGORY, "Queued %s local changes of %s: %s", [changes.length, namespace, changes.map((change) => change.path).join(", ")]);
        }
        for (const local of changes) {
            if (!isSyncPath(local.path) || isAtOrBelow(local.path, SERVER_PATH)) {
                continue;
            }
            if (isLocal(local.path)) {
                locals = locals.filter((kept) => !isAtOrBelow(kept.path, local.path));
                locals.push(copyJson<LocalChange>(local));
                markDirty("local");
                continue;
            }
            if (isSecret(local.path)) {
                if (welcomed) {
                    outbox.push({ change: { ...local, base: revision }, sent: false, secret: true });
                }
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
                report(CATEGORY, "Ignoring the saved state of %s: it is not a state and revision", [namespace]);
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
                report(CATEGORY, "Ignoring a saved change of %s that is not valid", [namespace]);
            }
        }
        const savedLocal = localStore.read(namespace, "local");
        locals = (Array.isArray(savedLocal) ? savedLocal : []).filter((change): change is LocalChange & JsonValue =>
            isRecord(change) && typeof change.path === "string" && isLocal(change.path) && (change.op === "set" || change.op === "delete" || change.op === "merge"));
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
            const restored = restore();
            const mounted = restored ?? options.initial;
            if (mounted) {
                mount(mounted);
                bridge.load(visibleState());
            }
            report(CATEGORY, "Started %s from %s at revision %s with %s changes waiting", [namespace, restored ? "the local store" : mounted ? "the initial state" : "nothing", revision, outbox.length]);
            unsubscribe = bridge.subscribe(enqueue);
            if (!transport) {
                setStatus("standalone");
                return;
            }
            setStatus("connecting");
            connect();
        },
        stop: () => {
            if (running) {
                report(CATEGORY, "Stopped %s at revision %s with %s changes waiting", [namespace, revision, outbox.length]);
            }
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
            outbox: outbox.filter((entry) => entry.secret !== true).map(({ change }) => copyJson<Change>(change))
        }),
        emit: (name, value) => {
            if (!welcomed) {
                return false;
            }
            send(value === undefined ? { type: "emit", name } : { type: "emit", name, value });
            return true;
        },
        durable: () => durable,
        requests: () => [...requests.values()].map((request) => copyJson<SyncRequest>(request)),
        approve: (id) => decide({ type: "approve", id }),
        reject: (id, note) => decide(note === undefined ? { type: "reject", id } : { type: "reject", id, note }),
        withdraw: (id) => decide({ type: "withdraw", id }),
        undo: () => travel("undo"),
        redo: () => travel("redo"),
        setPaths: (paths) => {
            if (paths.local !== undefined) {
                localPatterns = patternsOf(paths.local);
                const kept = locals.filter((change) => isLocal(change.path));
                if (kept.length !== locals.length) {
                    locals = kept;
                    markDirty("local");
                }
            }
            if (paths.secret !== undefined) {
                secretPatterns = patternsOf(paths.secret);
            }
        }
    };
};

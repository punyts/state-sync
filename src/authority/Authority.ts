import { report } from "@punyts/core";
import { createStore, type Store } from "@punyts/state";
import { applyChange, copyJson } from "../Apply.js";
import type { Change, JsonValue, RevisedChange } from "../Change.js";
import type { AckMessage, HelloMessage, SyncMessage } from "../Messages.js";
import { SERVER_PATH, isAtOrBelow, isSyncPath } from "../Paths.js";
import { syncSnapshot } from "../Snapshot.js";
import { DEFAULT_SYNC_LIMITS, parseMessage, type SyncLimits } from "../Validate.js";
import type { AppliedChange, NamespaceStorage, StoredNamespace } from "./NamespaceStorage.js";
import { touchesPattern } from "./Patterns.js";
import { decryptServerBranch, encryptServerBranch } from "./ServerCrypto.js";

/** The error codes an authority sends besides those of parseMessage (which also refuses another protocol version) */
export type AuthorityErrorCode = "wrong-namespace" | "no-hello";

/** One client connection, as the caller's WebSocket server gives it */
export interface AuthorityConnection {
    send: (text: string) => void;
    close: () => void;
}

/** What the caller passes the connection's events to */
export interface AuthoritySession {
    /** A message from the client, as text */
    receive: (text: string) => void;
    /** The connection closed */
    close: () => void;
}

export interface AuthorityOptions {
    namespace: string;
    storage: NamespaceStorage;
    /** The state at revision 0 when the storage holds nothing; empty by default */
    initial?: { [key: string]: JsonValue };
    /** The most recent changes kept for catching clients up; 1000 by default */
    logLength?: number;
    /** The most recent applied change ids remembered; 10000 by default, never fewer than the log */
    appliedLength?: number;
    limits?: Partial<SyncLimits>;
    /**
     * The 32-byte key $.server is encrypted with at rest (AES-256-GCM, a fresh nonce per value), from configuration;
     * never stored or logged. Without it the authority keeps no $.server: a server write there throws, and a stored or
     * initial state with one is refused
     */
    serverKey?: Uint8Array;
}

/** What a change handler gets */
export interface ChangeContext {
    /** The client's change, as adjusted by the handlers before this one */
    change: Change;
    /** The client id of the hello on the change's connection */
    clientId: string;
    /** A copy of the value at a path of the current state, $.server included */
    get: (path: string) => JsonValue | undefined;
    /** One of the changes since the change's base is at, above or below its path, or the base is older than the log */
    stale: boolean;
    /** The logged changes after the change's base, oldest first */
    since: RevisedChange[];
}

/** A handler's answer; undefined applies the change */
export type ChangeVerdict =
    | { result: "apply" }
    | { result: "adjust"; value: JsonValue }
    | { result: "reject"; reason: string }
    | undefined;

/** Server logic for client changes; synchronous, so changes stay in arrival order */
export type ChangeHandler = (context: ChangeContext) => ChangeVerdict;

/** Server logic for a client's emit */
export type EmitHandler = (name: string, value: JsonValue | undefined, clientId: string) => void;

/** A write made by server logic */
export type ServerWrite = Pick<Change, "path" | "op" | "value">;

export interface Authority {
    readonly namespace: string;
    /** Takes a client connection; the caller passes its messages and its close to the session */
    connect: (connection: AuthorityConnection) => AuthoritySession;
    /**
     * Registers server logic for client changes at, below or above the paths a pattern matches ("*" matches one
     * segment); returns the function that removes it
     */
    onChange: (pattern: string, handler: ChangeHandler) => () => void;
    /** Registers server logic for client emits; returns the function that removes it */
    onEmit: (handler: EmitHandler) => () => void;
    /**
     * A server write: applied at once and pushed to every client with the next revision, which it returns. A write at or
     * below $.server is applied and saved only: it takes no revision and never reaches a client. Throws for a path that
     * is not a sync path or whose parent does not exist.
     */
    write: (write: ServerWrite) => number | undefined;
    /** Sends a named event to every welcomed client */
    emit: (name: string, value?: JsonValue) => void;
    revision: () => number;
    /** A copy of the whole state, $.server included */
    state: () => { [key: string]: JsonValue };
    /** Resolves when every pending save is done */
    flush: () => Promise<void>;
    /** Closes every connection */
    close: () => void;
}

interface Session {
    connection: AuthorityConnection;
    /** Answered with welcome; only welcomed sessions get changes */
    welcomed: boolean;
    clientId: string;
}

interface RegisteredHandler {
    pattern: string;
    handler: ChangeHandler;
}

/** The parent of a "$."-prefixed path; "$" for a top-level path */
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("."));

const isComposite = (value: unknown) => typeof value === "object" && value !== null;

/** The key of $.server in the state */
const SERVER_KEY = SERVER_PATH.slice(2);

/** The $.server value as the object of named values it must be, encrypted one by one */
const serverBranch = (value: JsonValue | undefined, namespace: string): { [name: string]: JsonValue } => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${SERVER_PATH} of ${namespace} must be an object of named values`);
    }
    return value;
};

/**
 * The authority of a namespace: it numbers each change it accepts with the next revision, acks it, pushes it to the
 * other clients and catches reconnecting clients up from its log or with a snapshot. Change handlers (server logic) can
 * apply, adjust or reject a change; without them a change is applied in arrival order, stale or not. $.server never
 * leaves the authority.
 * @param options
 */
export const createAuthority = async (options: AuthorityOptions): Promise<Authority> => {
    const { namespace, storage } = options;
    const logLength = Math.max(0, options.logLength ?? 1000);
    const appliedLength = Math.max(logLength, options.appliedLength ?? 10_000);
    const limits: SyncLimits = { ...DEFAULT_SYNC_LIMITS, ...options.limits };

    const { serverKey } = options;
    const stored = await storage.load(namespace);
    const state = copyJson<{ [key: string]: JsonValue }>(stored?.state ?? options.initial ?? {});
    if (state[SERVER_KEY] !== undefined) {
        if (serverKey === undefined) {
            throw new Error(`The state of ${namespace} has ${SERVER_PATH}, but the authority has no serverKey`);
        }
        if (stored !== undefined) {
            state[SERVER_KEY] = decryptServerBranch(serverBranch(state[SERVER_KEY], namespace), serverKey, namespace);
        }
        else {
            serverBranch(state[SERVER_KEY], namespace);
        }
    }
    const store: Store<any> = createStore(state);
    let revision = stored?.revision ?? 0;
    const log: RevisedChange[] = (stored?.log ?? []).slice(-logLength);
    //insertion order is the order the ids were applied in
    const applied = new Map<string, number>((stored?.applied ?? []).map(({ id, revision }) => [id, revision]));

    const sessions = new Set<Session>();
    const handlers: RegisteredHandler[] = [];
    const emitHandlers = new Set<EmitHandler>();

    let dirty = false;
    let saving: Promise<void> = Promise.resolve();
    let saveScheduled = false;

    const storedNamespace = (): StoredNamespace => {
        const state = copyJson<{ [key: string]: JsonValue }>(store.get("$"));
        if (state[SERVER_KEY] !== undefined && serverKey !== undefined) {
            //$.server is only ever saved encrypted
            state[SERVER_KEY] = encryptServerBranch(serverBranch(state[SERVER_KEY], namespace), serverKey, namespace);
        }
        return {
            state,
            revision,
            log: copyJson<RevisedChange[]>(log),
            applied: [...applied].map(([id, revision]): AppliedChange => ({ id, revision }))
        };
    };

    const save = async () => {
        if (!dirty) {
            return;
        }
        dirty = false;
        try {
            await storage.save(namespace, storedNamespace());
        }
        catch (error) {
            //tried again with the next change
            dirty = true;
            report("state-sync", "Could not save namespace %s at revision %s: %s", [namespace, revision, error instanceof Error ? error.message : String(error)]);
        }
    };

    const scheduleSave = () => {
        dirty = true;
        if (saveScheduled) {
            return;
        }
        saveScheduled = true;
        queueMicrotask(() => {
            saveScheduled = false;
            //one save at a time; a save after the one running takes every change made meanwhile
            saving = saving.then(save);
        });
    };

    const send = (session: Session, message: SyncMessage) => {
        try {
            session.connection.send(JSON.stringify(message));
        }
        catch (error) {
            report("state-sync", "Could not send a %s message in %s: %s", [message.type, namespace, error instanceof Error ? error.message : String(error)]);
        }
    };

    const refuse = (session: Session, code: AuthorityErrorCode, message: string, close: boolean) => {
        send(session, { type: "error", code, message });
        if (close) {
            sessions.delete(session);
            session.connection.close();
        }
    };

    const onHello = (session: Session, hello: HelloMessage) => {
        if (hello.namespace !== namespace) {
            refuse(session, "wrong-namespace", `this connection syncs ${namespace}`, true);
            return;
        }
        const missing = revision - hello.revision;
        //a client at 0 has nothing; one ahead of the authority has a state the authority does not know
        const logged = hello.revision > 0 && missing >= 0 && missing <= log.length && missing <= limits.maxChanges;
        send(session, logged
            ? { type: "welcome", namespace, revision, changes: log.slice(log.length - missing) }
            : { type: "welcome", namespace, revision, snapshot: syncSnapshot(store) });
        session.welcomed = true;
        session.clientId = hello.clientId;
    };

    const ack = (session: Session, message: Omit<AckMessage, "type">) => send(session, { type: "ack", ...message });

    /** Why the change cannot be applied to the store, or undefined when it can */
    const missingParent = (change: Pick<Change, "path" | "op">): string | undefined => {
        const parent = parentOf(change.path);
        return change.op !== "delete" && parent !== "$" && !isComposite(store.get(parent))
            ? `${parent} does not exist`
            : undefined;
    };

    /** Applies an accepted change at the next revision, logs it and pushes it to every welcomed session but the writer */
    const commit = (change: Change, writer?: Session): number => {
        applyChange(store, change);
        revision++;
        const revised: RevisedChange = { ...copyJson<Change>(change), revision };
        log.push(revised);
        if (log.length > logLength) {
            log.splice(0, log.length - logLength);
        }
        scheduleSave();
        for (const other of sessions) {
            if (other !== writer && other.welcomed) {
                send(other, { type: "changes", changes: [revised] });
            }
        }
        return revision;
    };

    /** Runs the handlers that touch the change in registration order: the change as adjusted, or the first rejection */
    const runHandlers = (session: Session, received: Change): { change: Change; adjusted: boolean } | { reason: string } => {
        let change = received;
        let adjusted = false;
        const since = log.filter((logged) => logged.revision > received.base);
        const stale = received.base < revision - log.length ||
            since.some((logged) => isAtOrBelow(logged.path, received.path) || isAtOrBelow(received.path, logged.path));
        for (const { pattern, handler } of [...handlers]) {
            if (!touchesPattern(pattern, received.path)) {
                continue;
            }
            let verdict: ChangeVerdict;
            try {
                verdict = handler({
                    change: copyJson<Change>(change),
                    clientId: session.clientId,
                    get: (path) => copyJson(store.get(path)),
                    stale,
                    since: copyJson<RevisedChange[]>(since)
                });
            }
            catch (error) {
                report("state-sync", "A change handler for %s in %s failed: %s", [pattern, namespace, error instanceof Error ? error.message : String(error)]);
                return { reason: "server logic failed" };
            }
            if (verdict?.result === "reject") {
                return { reason: verdict.reason };
            }
            if (verdict?.result === "adjust") {
                change = { ...change, op: "set", value: copyJson(verdict.value) };
                adjusted = true;
            }
        }
        return { change, adjusted };
    };

    const onChange = (session: Session, received: Change) => {
        const known = applied.get(received.id);
        if (known !== undefined) {
            ack(session, { id: received.id, result: "applied", revision: known });
            return;
        }
        if (isAtOrBelow(received.path, SERVER_PATH)) {
            ack(session, { id: received.id, result: "rejected", reason: `${SERVER_PATH} is server-only` });
            return;
        }
        const outcome = runHandlers(session, received);
        if ("reason" in outcome) {
            ack(session, { id: received.id, result: "rejected", reason: outcome.reason });
            return;
        }
        const { change, adjusted } = outcome;
        //checked after the handlers: an adjust turns a delete into a set
        const missing = missingParent(change);
        if (missing !== undefined) {
            ack(session, { id: received.id, result: "rejected", reason: missing });
            return;
        }
        const at = commit(change, session);
        applied.set(change.id, at);
        if (applied.size > appliedLength) {
            applied.delete(applied.keys().next().value!);
        }
        ack(session, adjusted
            ? { id: change.id, result: "adjusted", revision: at, value: copyJson(change.value) }
            : { id: change.id, result: "applied", revision: at });
    };

    const onEmit = (session: Session, name: string, value: JsonValue | undefined) => {
        for (const handler of [...emitHandlers]) {
            try {
                handler(name, copyJson(value), session.clientId);
            }
            catch (error) {
                report("state-sync", "An emit handler for %s in %s failed: %s", [name, namespace, error instanceof Error ? error.message : String(error)]);
            }
        }
    };

    const receive = (session: Session, text: string) => {
        if (!sessions.has(session)) {
            return;
        }
        const parsed = parseMessage(text, limits);
        if (!parsed.ok) {
            send(session, parsed.error);
            return;
        }
        const message = parsed.message;
        switch (message.type) {
            case "hello":
                onHello(session, message);
                return;
            case "change":
                if (!session.welcomed) {
                    refuse(session, "no-hello", "send hello first", false);
                    return;
                }
                onChange(session, message.change);
                return;
            case "emit":
                if (!session.welcomed) {
                    refuse(session, "no-hello", "send hello first", false);
                    return;
                }
                onEmit(session, message.name, message.value);
                return;
            case "error":
                report("state-sync", "A client of %s sent an error: %s %s", [namespace, message.code, message.message]);
                return;
            default:
                report("state-sync", "Ignoring a %s message from a client of %s", [message.type, namespace]);
        }
    };

    return {
        namespace,
        connect: (connection) => {
            const session: Session = { connection, welcomed: false, clientId: "" };
            sessions.add(session);
            return {
                receive: (text) => receive(session, text),
                close: () => {
                    sessions.delete(session);
                }
            };
        },
        onChange: (pattern, handler) => {
            const registered: RegisteredHandler = { pattern, handler };
            handlers.push(registered);
            return () => {
                const index = handlers.indexOf(registered);
                if (index >= 0) {
                    handlers.splice(index, 1);
                }
            };
        },
        onEmit: (handler) => {
            emitHandlers.add(handler);
            return () => {
                emitHandlers.delete(handler);
            };
        },
        write: (write) => {
            if (!isSyncPath(write.path)) {
                throw new Error(`${write.path} is not a sync path`);
            }
            const server = isAtOrBelow(write.path, SERVER_PATH);
            if (server && serverKey === undefined) {
                throw new Error(`${SERVER_PATH} needs a serverKey, so it is never stored in plaintext`);
            }
            const missing = missingParent(write);
            if (missing !== undefined) {
                throw new Error(missing);
            }
            if (server) {
                if (write.path === SERVER_PATH && write.op !== "delete") {
                    serverBranch(write.value, namespace);
                }
                //server-only: no revision, so clients never see a gap
                applyChange(store, write);
                scheduleSave();
                return undefined;
            }
            const change: Change = write.value === undefined
                ? { id: globalThis.crypto.randomUUID(), path: write.path, op: write.op, base: revision }
                : { id: globalThis.crypto.randomUUID(), path: write.path, op: write.op, value: copyJson(write.value), base: revision };
            return commit(change);
        },
        emit: (name, value) => {
            for (const session of sessions) {
                if (session.welcomed) {
                    send(session, value === undefined ? { type: "emit", name } : { type: "emit", name, value });
                }
            }
        },
        revision: () => revision,
        state: () => copyJson(store.get("$")),
        flush: async () => {
            if (saveScheduled) {
                //the scheduled save was queued first, so it has joined the chain when this resolves
                await new Promise<void>((resolve) => queueMicrotask(resolve));
            }
            await saving;
        },
        close: () => {
            for (const session of [...sessions]) {
                sessions.delete(session);
                session.connection.close();
            }
        }
    };
};

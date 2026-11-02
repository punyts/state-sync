import { report } from "@punyts/core";
import { createStore, type Store } from "@punyts/state";
import { applyChange, copyJson } from "../Apply.js";
import type { Change, JsonValue, RevisedChange } from "../Change.js";
import type { AckMessage, HelloMessage, SyncMessage } from "../Messages.js";
import { SERVER_PATH, isAtOrBelow } from "../Paths.js";
import { syncSnapshot } from "../Snapshot.js";
import { DEFAULT_SYNC_LIMITS, parseMessage, type SyncLimits } from "../Validate.js";
import type { AppliedChange, NamespaceStorage, StoredNamespace } from "./NamespaceStorage.js";

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
}

export interface Authority {
    readonly namespace: string;
    /** Takes a client connection; the caller passes its messages and its close to the session */
    connect: (connection: AuthorityConnection) => AuthoritySession;
    revision: () => number;
    /** A copy of the whole state */
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
}

/** The parent of a "$."-prefixed path; "$" for a top-level path */
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("."));

const isComposite = (value: unknown) => typeof value === "object" && value !== null;

/**
 * The authority of a namespace: it numbers each change it accepts with the next revision, acks it, pushes it to the
 * other clients and catches reconnecting clients up from its log or with a snapshot. Without server logic a change is
 * applied in arrival order, stale or not.
 * @param options
 */
export const createAuthority = async (options: AuthorityOptions): Promise<Authority> => {
    const { namespace, storage } = options;
    const logLength = Math.max(0, options.logLength ?? 1000);
    const appliedLength = Math.max(logLength, options.appliedLength ?? 10_000);
    const limits: SyncLimits = { ...DEFAULT_SYNC_LIMITS, ...options.limits };

    const stored = await storage.load(namespace);
    const store: Store<any> = createStore(copyJson(stored?.state ?? options.initial ?? {}));
    let revision = stored?.revision ?? 0;
    const log: RevisedChange[] = (stored?.log ?? []).slice(-logLength);
    //insertion order is the order the ids were applied in
    const applied = new Map<string, number>((stored?.applied ?? []).map(({ id, revision }) => [id, revision]));

    const sessions = new Set<Session>();

    let dirty = false;
    let saving: Promise<void> = Promise.resolve();
    let saveScheduled = false;

    const storedNamespace = (): StoredNamespace => ({
        state: copyJson(store.get("$")),
        revision,
        log: copyJson<RevisedChange[]>(log),
        applied: [...applied].map(([id, revision]): AppliedChange => ({ id, revision }))
    });

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
    };

    const ack = (session: Session, message: Omit<AckMessage, "type">) => send(session, { type: "ack", ...message });

    /** Why a change cannot be applied, or undefined when it can */
    const refusal = (change: Change): string | undefined => {
        if (isAtOrBelow(change.path, SERVER_PATH)) {
            return `${SERVER_PATH} is server-only`;
        }
        const parent = parentOf(change.path);
        if (change.op !== "delete" && parent !== "$" && !isComposite(store.get(parent))) {
            return `${parent} does not exist`;
        }
        return undefined;
    };

    const onChange = (session: Session, change: Change) => {
        const known = applied.get(change.id);
        if (known !== undefined) {
            ack(session, { id: change.id, result: "applied", revision: known });
            return;
        }
        const reason = refusal(change);
        if (reason !== undefined) {
            ack(session, { id: change.id, result: "rejected", reason });
            return;
        }
        applyChange(store, change);
        revision++;
        const revised: RevisedChange = { ...copyJson<Change>(change), revision };
        log.push(revised);
        if (log.length > logLength) {
            log.splice(0, log.length - logLength);
        }
        applied.set(change.id, revision);
        if (applied.size > appliedLength) {
            applied.delete(applied.keys().next().value!);
        }
        scheduleSave();
        ack(session, { id: change.id, result: "applied", revision });
        for (const other of sessions) {
            if (other !== session && other.welcomed) {
                send(other, { type: "changes", changes: [revised] });
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
            case "error":
                report("state-sync", "A client of %s sent an error: %s %s", [namespace, message.code, message.message]);
                return;
            default:
                //emit and server logic come with S1.6
                return;
        }
    };

    return {
        namespace,
        connect: (connection) => {
            const session: Session = { connection, welcomed: false };
            sessions.add(session);
            return {
                receive: (text) => receive(session, text),
                close: () => {
                    sessions.delete(session);
                }
            };
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

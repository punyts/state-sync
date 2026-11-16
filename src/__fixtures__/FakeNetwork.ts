import { createStore, type Store } from "@punyts/state";
import { applyChange, copyJson } from "../Apply.js";
import type { Change, JsonValue, RevisedChange } from "../Change.js";
import type { SyncMessage } from "../Messages.js";
import type { SyncTransport, TransportConnection, TransportHandlers } from "../Transport.js";
import { parseMessage } from "../Validate.js";

interface FakeConnection {
    handlers: TransportHandlers;
    open: boolean;
}

export interface FakeAuthorityOptions {
    state?: { [key: string]: JsonValue };
    /** A reason refuses the change */
    reject?: (change: Change) => string | undefined;
    /** A value adjusts the change: the path gets it instead */
    adjust?: (change: Change) => JsonValue | undefined;
    /** Always answer hello with a snapshot */
    snapshots?: boolean;
}

/**
 * An authority and the network to it, for client tests. Messages wait in a queue until settle() delivers them, so a
 * test decides when the network moves and can lose messages on the way.
 */
export const createFakeNetwork = (namespace: string, options: FakeAuthorityOptions = {}) => {
    const store: Store<any> = createStore(copyJson(options.state ?? {}));
    //the starting state is revision 1, so a client with nothing (revision 0) is behind the log and gets a snapshot
    let revision = 1;
    const log: RevisedChange[] = [];
    const applied = new Map<string, number>();
    const connections = new Set<FakeConnection>();
    //connections asked for while offline: they open when the network is back
    const waiting = new Set<FakeConnection>();
    const queue: (() => void)[] = [];
    const received: SyncMessage[] = [];
    let online = true;
    let lose: ((message: SyncMessage) => boolean) | undefined;
    //set by revoke(): every hello is answered with the error `revoked`
    let revokedWith: string | undefined;

    const toClient = (connection: FakeConnection, message: SyncMessage) => {
        queue.push(() => {
            if (!connection.open) {
                return;
            }
            if (lose?.(message)) {
                lose = undefined;
                return;
            }
            connection.handlers.onMessage(JSON.stringify(message));
        });
    };

    const accept = (from: FakeConnection, change: RevisedChange) => {
        log.push(change);
        applied.set(change.id, change.revision);
        for (const connection of connections) {
            if (connection !== from) {
                toClient(connection, { type: "changes", changes: [change] });
            }
        }
    };

    const handle = (connection: FakeConnection, message: SyncMessage) => {
        received.push(message);
        if (message.type === "hello") {
            if (revokedWith !== undefined) {
                toClient(connection, { type: "error", code: "revoked", message: revokedWith });
                return;
            }
            const oldest = revision - log.length;
            toClient(connection, options.snapshots || message.revision < oldest
                ? { type: "welcome", namespace, revision, snapshot: copyJson(store.get("$")) }
                : { type: "welcome", namespace, revision, changes: log.filter((change) => change.revision > message.revision) });
            return;
        }
        if (message.type !== "change") {
            return;
        }
        const change = message.change;
        const known = applied.get(change.id);
        if (known !== undefined) {
            toClient(connection, { type: "ack", id: change.id, result: "applied", revision: known });
            return;
        }
        const reason = options.reject?.(change);
        if (reason !== undefined) {
            toClient(connection, { type: "ack", id: change.id, result: "rejected", reason });
            return;
        }
        const adjusted = options.adjust?.(change);
        if (adjusted !== undefined) {
            applyChange(store, { path: change.path, op: "set", value: adjusted });
            revision++;
            toClient(connection, { type: "ack", id: change.id, result: "adjusted", revision, value: adjusted });
            accept(connection, { id: change.id, path: change.path, op: "set", value: adjusted, base: change.base, revision });
            return;
        }
        applyChange(store, change);
        revision++;
        toClient(connection, { type: "ack", id: change.id, result: "applied", revision });
        accept(connection, { ...change, revision });
    };

    const transport: SyncTransport = {
        connect: (handlers): TransportConnection => {
            const connection: FakeConnection = { handlers, open: online };
            if (online) {
                connections.add(connection);
                queue.push(() => connection.open && handlers.onOpen());
            }
            else {
                waiting.add(connection);
            }
            return {
                send: (text) => {
                    if (!connection.open) {
                        throw new Error("send on a closed connection");
                    }
                    const parsed = parseMessage(text);
                    if (!parsed.ok) {
                        throw new Error(parsed.error.message);
                    }
                    queue.push(() => connection.open && handle(connection, parsed.message));
                },
                close: () => {
                    connection.open = false;
                    connections.delete(connection);
                    waiting.delete(connection);
                }
            };
        }
    };

    return {
        transport,
        store,
        /** Every message the authority got, in order */
        received,
        revision: () => revision,
        /** Delivers queued messages, timers and microtasks until nothing moves */
        settle: async () => {
            for (let round = 0; round < 1000; round++) {
                await new Promise((resolve) => setTimeout(resolve, 0));
                if (queue.length === 0) {
                    await new Promise((resolve) => setTimeout(resolve, 0));
                    if (queue.length === 0) {
                        return;
                    }
                }
                while (queue.length > 0) {
                    queue.shift()!();
                }
            }
            throw new Error("the network never settled");
        },
        /** Drops every connection; new ones wait until online again */
        goOffline: () => {
            online = false;
            for (const connection of connections) {
                connection.open = false;
                queue.push(() => connection.handlers.onClose());
            }
            connections.clear();
        },
        /** Opens the connections that waited */
        goOnline: () => {
            online = true;
            for (const connection of waiting) {
                connection.open = true;
                connections.add(connection);
                queue.push(() => connection.open && connection.handlers.onOpen());
            }
            waiting.clear();
        },
        /** The next message to a client that matches is lost */
        loseNext: (match: (message: SyncMessage) => boolean) => {
            lose = match;
        },
        /** Revokes the namespace: the connected clients get the error `revoked`, and so does every later hello */
        revoke: (message: string) => {
            revokedWith = message;
            for (const connection of connections) {
                toClient(connection, { type: "error", code: "revoked", message });
            }
        },
        /** Sends an emit to every connected client */
        emit: (name: string, value?: JsonValue) => {
            for (const connection of connections) {
                toClient(connection, value === undefined ? { type: "emit", name } : { type: "emit", name, value });
            }
        },
        /** A change made at the authority by another writer */
        write: (change: Omit<Change, "base" | "id"> & { id?: string }) => {
            const full = { id: change.id ?? `server-${revision + 1}`, base: revision, ...change } as Change;
            applyChange(store, full);
            revision++;
            accept(undefined as unknown as FakeConnection, { ...full, revision });
        }
    };
};

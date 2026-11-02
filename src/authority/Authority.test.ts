import { afterEach, describe, expect, it, vi } from "vitest";
import { report } from "@punyts/core";
import { createStore, type Store } from "@punyts/state";
import { copyJson } from "../Apply.js";
import { createStoreBridge } from "../Bridge.js";
import type { Change } from "../Change.js";
import { createSyncClient, type SyncClient } from "../Client.js";
import type { SyncMessage } from "../Messages.js";
import { createInProcessTransport, settle } from "../__fixtures__/InProcessTransport.js";
import { createAuthority, type AuthorityOptions } from "./Authority.js";
import { createMemoryNamespaceStorage, type NamespaceStorage } from "./NamespaceStorage.js";

vi.mock("@punyts/core", async (original) => ({ ...(await original<typeof import("@punyts/core")>()), report: vi.fn() }));

const NAMESPACE = "apps.orders";

const STATE = Object.freeze({
    app: Object.freeze({ page: 1 }),
    data: Object.freeze({ total: 10, items: Object.freeze([]) as unknown as never[] })
});

const hello = (revision = 0, namespace = NAMESPACE) => JSON.stringify({ type: "hello", namespace, revision, clientId: "c", protocol: 1 });

let counter = 0;
const change = (path: string, value: unknown, op: Change["op"] = "set", id = `id-${++counter}`) =>
    JSON.stringify({ type: "change", change: value === undefined ? { id, path, op, base: 0 } : { id, path, op, value, base: 0 } });

const setup = async (options: Partial<AuthorityOptions> = {}) => {
    const storage = options.storage ?? createMemoryNamespaceStorage();
    const authority = await createAuthority({ namespace: NAMESPACE, storage, initial: copyJson(STATE), ...options });
    /** A client connection that records what the authority sends it */
    const join = (revision?: number) => {
        const received: SyncMessage[] = [];
        const close = vi.fn();
        const session = authority.connect({ send: (text) => received.push(JSON.parse(text)), close });
        if (revision !== undefined) {
            session.receive(hello(revision));
        }
        return { received, session, close };
    };
    return { authority, storage, join };
};

afterEach(() => {
    vi.mocked(report).mockClear();
});

describe("createAuthority", () => {
    describe("hello", () => {
        it("should answer a client with nothing with a snapshot at the current revision", async () => {
            const { join } = await setup();

            const { received } = join(0);

            expect(received).toEqual([{ type: "welcome", namespace: NAMESPACE, revision: 0, snapshot: STATE }]);
        });

        it("should answer a client in the log with the changes after its revision", async () => {
            const { join } = await setup();
            const writer = join(0);
            writer.session.receive(change("$.data.total", 11, "set", "a"));
            writer.session.receive(change("$.app.page", 2, "set", "b"));

            const { received } = join(1);

            expect(received).toEqual([{
                type: "welcome",
                namespace: NAMESPACE,
                revision: 2,
                changes: [{ id: "b", path: "$.app.page", op: "set", value: 2, base: 0, revision: 2 }]
            }]);
        });

        it("should answer a client at the current revision with no changes", async () => {
            const { join } = await setup();
            join(0).session.receive(change("$.data.total", 11));

            const { received } = join(1);

            expect(received).toEqual([{ type: "welcome", namespace: NAMESPACE, revision: 1, changes: [] }]);
        });

        it("should send a snapshot to a client behind the log", async () => {
            const { join } = await setup({ logLength: 2 });
            const writer = join(0);
            for (let total = 11; total <= 14; total++) {
                writer.session.receive(change("$.data.total", total));
            }

            const behind = join(1);
            const inLog = join(2);

            expect(behind.received).toEqual([{ type: "welcome", namespace: NAMESPACE, revision: 4, snapshot: { ...STATE, data: { ...STATE.data, total: 14 } } }]);
            expect(inLog.received[0]).toMatchObject({ revision: 4, changes: [{ revision: 3 }, { revision: 4 }] });
        });

        it("should send a snapshot to a client ahead of the authority or further behind than maxChanges", async () => {
            const { join } = await setup({ limits: { maxChanges: 1 } });
            const writer = join(0);
            writer.session.receive(change("$.data.total", 11));
            writer.session.receive(change("$.data.total", 12));
            writer.session.receive(change("$.data.total", 13));

            const ahead = join(9);
            const tooFar = join(1);

            expect(ahead.received[0]).toHaveProperty("snapshot");
            expect(tooFar.received[0]).toHaveProperty("snapshot");
        });

        it("should keep $.runtime and $.server out of a snapshot", async () => {
            const { join } = await setup({ initial: { data: { total: 1 }, server: { key: "secret" } }, serverKey: new Uint8Array(32) });

            const { received } = join(0);

            expect(received[0]).toMatchObject({ snapshot: { data: { total: 1 } } });
            expect(JSON.stringify(received)).not.toContain("secret");
        });

        it("should refuse a hello for another namespace and close the connection", async () => {
            const { join } = await setup();
            const other = join();

            other.session.receive(hello(0, "apps.other"));
            other.session.receive(hello(0));

            expect(other.received).toEqual([{ type: "error", code: "wrong-namespace", message: `this connection syncs ${NAMESPACE}` }]);
            expect(other.close).toHaveBeenCalled();
        });

        it("should refuse a hello of another protocol version without welcoming it", async () => {
            const { join } = await setup();
            const old = join();

            old.session.receive(JSON.stringify({ type: "hello", namespace: NAMESPACE, revision: 0, clientId: "c", protocol: 2 }));
            old.session.receive(change("$.data.total", 1));

            expect(old.received.map((message) => message.type === "error" && message.code)).toEqual(["invalid-message", "no-hello"]);
        });
    });

    describe("changes", () => {
        it("should apply a change at the next revision, ack it and push it to the other welcomed clients", async () => {
            const { authority, join } = await setup();
            const writer = join(0);
            const reader = join(0);
            const waiting = join();

            writer.session.receive(change("$.data.total", 12, "set", "x"));

            expect(authority.state()).toMatchObject({ data: { total: 12 } });
            expect(writer.received.at(-1)).toEqual({ type: "ack", id: "x", result: "applied", revision: 1 });
            expect(reader.received.at(-1)).toEqual({
                type: "changes",
                changes: [{ id: "x", path: "$.data.total", op: "set", value: 12, base: 0, revision: 1 }]
            });
            expect(waiting.received).toEqual([]);
        });

        it("should apply a repeated id once and ack it with its revision", async () => {
            const { authority, join } = await setup();
            const writer = join(0);
            const reader = join(0);
            writer.session.receive(change("$.data.items", ["a"], "set", "x"));
            writer.session.receive(change("$.data.total", 3, "set", "y"));

            writer.session.receive(change("$.data.items", ["a"], "set", "x"));

            expect(authority.revision()).toBe(2);
            expect(writer.received.at(-1)).toEqual({ type: "ack", id: "x", result: "applied", revision: 1 });
            expect(reader.received.filter((message) => message.type === "changes")).toHaveLength(2);
        });

        it("should remember applied ids beyond the log", async () => {
            const { authority, join } = await setup({ logLength: 1 });
            const writer = join(0);
            writer.session.receive(change("$.data.total", 1, "set", "x"));
            writer.session.receive(change("$.data.total", 2, "set", "y"));

            writer.session.receive(change("$.data.total", 1, "set", "x"));

            expect(authority.revision()).toBe(2);
            expect(authority.state()).toMatchObject({ data: { total: 2 } });
        });

        it("should apply a stale change in arrival order", async () => {
            const { authority, join } = await setup();
            const first = join(0);
            const second = join(0);
            first.session.receive(change("$.data.total", 20));

            //based on revision 0, before the change above
            second.session.receive(change("$.data.total", 30));

            expect(authority.state()).toMatchObject({ data: { total: 30 } });
            expect(second.received.at(-1)).toMatchObject({ result: "applied", revision: 2 });
        });

        it("should apply every op with the store's own methods", async () => {
            const { authority, join } = await setup();
            const writer = join(0);

            writer.session.receive(change("$.data.order", { id: "k1", qty: 1, note: "n" }));
            writer.session.receive(change("$.data.order", { qty: 2 }, "merge"));
            writer.session.receive(change("$.app", { theme: "dark" }, "replace"));
            writer.session.receive(change("$.data.total", undefined, "delete"));

            expect(authority.state()).toEqual({ app: { theme: "dark" }, data: { items: [], order: { id: "k1", qty: 2, note: "n" } } });
            expect(authority.revision()).toBe(4);
        });

        it("should reject a change under $.server or under a parent that does not exist", async () => {
            const { authority, join } = await setup();
            const writer = join(0);
            const reader = join(0);

            writer.session.receive(change("$.server.key", "k", "set", "s"));
            writer.session.receive(change("$.data.missing.total", 1, "set", "m"));

            expect(writer.received.slice(-2)).toEqual([
                { type: "ack", id: "s", result: "rejected", reason: "$.server is server-only" },
                { type: "ack", id: "m", result: "rejected", reason: "$.data.missing does not exist" }
            ]);
            expect(authority.revision()).toBe(0);
            expect(reader.received).toHaveLength(1);
        });

        it("should allow a new top-level branch and a delete of a path that does not exist", async () => {
            const { authority, join } = await setup();
            const writer = join(0);

            writer.session.receive(change("$.extra", { a: 1 }));
            writer.session.receive(change("$.data.none", undefined, "delete"));

            expect(authority.state()).toMatchObject({ extra: { a: 1 } });
            expect(authority.revision()).toBe(2);
        });

        it("should answer a change before hello with an error and not apply it", async () => {
            const { authority, join } = await setup();
            const early = join();

            early.session.receive(change("$.data.total", 1));

            expect(early.received).toEqual([{ type: "error", code: "no-hello", message: "send hello first" }]);
            expect(early.close).not.toHaveBeenCalled();
            expect(authority.revision()).toBe(0);
        });

        it("should answer a message it refuses with the error of parseMessage", async () => {
            const { join } = await setup();
            const client = join(0);

            client.session.receive("{oops");
            client.session.receive(change("$.runtime.x", 1));

            expect(client.received.slice(1).map((message) => message.type === "error" && message.code)).toEqual(["invalid-json", "invalid-message"]);
        });

        it("should send nothing to a closed session and ignore what it receives", async () => {
            const { authority, join } = await setup();
            const writer = join(0);
            const gone = join(0);

            gone.session.close();
            gone.session.receive(change("$.data.total", 5));
            writer.session.receive(change("$.data.total", 6));

            expect(gone.received).toHaveLength(1);
            expect(authority.revision()).toBe(1);
        });

        it("should keep revisions increasing by one with no reuse", async () => {
            const { authority, join } = await setup();
            const writer = join(0);
            const revisions: number[] = [];

            for (let index = 0; index < 5; index++) {
                writer.session.receive(change("$.data.total", index));
                writer.session.receive(change("$.data.missing.x", index));
                revisions.push(authority.revision());
            }

            expect(revisions).toEqual([1, 2, 3, 4, 5]);
            expect(writer.received.filter((message) => message.type === "ack" && message.result === "applied").map((message) => message.type === "ack" && message.revision)).toEqual([1, 2, 3, 4, 5]);
        });
    });

    describe("storage", () => {
        it("should save the state, revision, log and applied ids and resume from them", async () => {
            const storage = createMemoryNamespaceStorage();
            const first = await setup({ storage, logLength: 1 });
            const writer = first.join(0);
            writer.session.receive(change("$.data.total", 1, "set", "x"));
            writer.session.receive(change("$.data.total", 2, "set", "y"));
            await first.authority.flush();

            const second = await setup({ storage, logLength: 1, initial: {} });
            const client = second.join(1);
            client.session.receive(change("$.data.total", 1, "set", "x"));

            expect(await storage.load(NAMESPACE)).toMatchObject({
                revision: 2,
                log: [{ id: "y", revision: 2 }],
                applied: [{ id: "x", revision: 1 }, { id: "y", revision: 2 }]
            });
            expect(second.authority.state()).toMatchObject({ data: { total: 2 } });
            expect(client.received).toEqual([
                { type: "welcome", namespace: NAMESPACE, revision: 2, changes: [{ id: "y", path: "$.data.total", op: "set", value: 2, base: 0, revision: 2 }] },
                { type: "ack", id: "x", result: "applied", revision: 1 }
            ]);
        });

        it("should coalesce saves and save one at a time", async () => {
            const inner = createMemoryNamespaceStorage();
            let running = 0;
            let most = 0;
            const save = vi.fn(async (namespace: string, stored: Parameters<NamespaceStorage["save"]>[1]) => {
                running++;
                most = Math.max(most, running);
                await new Promise((resolve) => setTimeout(resolve, 5));
                await inner.save(namespace, stored);
                running--;
            });
            const { authority, join } = await setup({ storage: { load: inner.load, save } });
            const writer = join(0);

            writer.session.receive(change("$.data.total", 1));
            writer.session.receive(change("$.data.total", 2));
            await Promise.resolve();
            writer.session.receive(change("$.data.total", 3));
            await authority.flush();
            await settle();

            expect(save.mock.calls.length).toBeLessThanOrEqual(2);
            expect(most).toBe(1);
            expect(await inner.load(NAMESPACE)).toMatchObject({ revision: 3, state: { data: { total: 3 } } });
        });

        it("should report a failed save and save again with the next change", async () => {
            const inner = createMemoryNamespaceStorage();
            let fail = true;
            const { authority, join } = await setup({
                storage: {
                    load: inner.load,
                    save: async (namespace, stored) => {
                        if (fail) {
                            throw new Error("disk full");
                        }
                        await inner.save(namespace, stored);
                    }
                }
            });
            const writer = join(0);

            writer.session.receive(change("$.data.total", 1));
            await authority.flush();
            const reported = vi.mocked(report).mock.calls.some(([, message]) => message.startsWith("Could not save namespace"));
            fail = false;
            writer.session.receive(change("$.data.total", 2));
            await authority.flush();

            expect(reported).toBe(true);
            expect(await inner.load(NAMESPACE)).toMatchObject({ revision: 2 });
        });
    });

    describe("close", () => {
        it("should close every connection", async () => {
            const { authority, join } = await setup();
            const one = join(0);
            const two = join();

            authority.close();
            one.session.receive(change("$.data.total", 1));

            expect(one.close).toHaveBeenCalled();
            expect(two.close).toHaveBeenCalled();
            expect(authority.revision()).toBe(0);
        });
    });

    describe("with sync clients", () => {
        let clients: SyncClient[] = [];

        afterEach(() => {
            clients.forEach((client) => client.stop());
            clients = [];
        });

        const open = (transport: ReturnType<typeof createInProcessTransport>["transport"]) => {
            const store: Store<any> = createStore({});
            const client = createSyncClient({ namespace: NAMESPACE, bridge: createStoreBridge(store), transport, backoff: () => 0 });
            clients.push(client);
            client.start();
            return { store, client };
        };

        it("should let two clients see each other's changes", async () => {
            const { authority } = await setup();
            const { transport } = createInProcessTransport(authority);
            const one = open(transport);
            const two = open(transport);
            await settle();

            one.store.set("$.data.total", 42);
            two.store.set("$.app.page", 7);
            await settle();

            expect(one.store.get("$")).toEqual({ app: { page: 7 }, data: { total: 42, items: [] } });
            expect(two.store.get("$")).toEqual(one.store.get("$"));
            expect(authority.revision()).toBe(2);
            expect(one.client.state()).toMatchObject({ revision: 2, outbox: [] });
            expect(two.client.state()).toMatchObject({ revision: 2, outbox: [] });
        });

        it("should catch a dropped client up and apply its offline change once", async () => {
            const { authority } = await setup();
            const network = createInProcessTransport(authority);
            const one = open(network.transport);
            const two = open(network.transport);
            await settle();

            network.drop();
            one.store.set("$.data.total", 1);
            await settle();
            two.store.set("$.app.page", 3);
            await settle(40);

            expect(authority.revision()).toBe(2);
            expect(one.store.get("$")).toEqual({ app: { page: 3 }, data: { total: 1, items: [] } });
            expect(two.store.get("$")).toEqual(one.store.get("$"));
        });

        it("should give a client behind the log a snapshot", async () => {
            const { authority } = await setup({ logLength: 1 });
            const { transport } = createInProcessTransport(authority);
            const one = open(transport);
            await settle();
            one.store.set("$.data.total", 4);
            await settle();
            one.client.stop();
            const writer = open(transport);
            await settle();
            writer.store.set("$.data.total", 5);
            writer.store.set("$.app.page", 9);
            await settle();
            writer.store.set("$.data.total", 6);
            await settle();

            const back = createSyncClient({
                namespace: NAMESPACE,
                bridge: createStoreBridge(one.store),
                transport,
                initial: one.client.state()
            });
            clients.push(back);
            back.start();
            await settle();

            expect(one.store.get("$")).toEqual({ app: { page: 9 }, data: { total: 6, items: [] } });
            expect(back.state().revision).toBe(authority.revision());
        });
    });
});

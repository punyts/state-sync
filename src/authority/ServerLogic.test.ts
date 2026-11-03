import { afterEach, describe, expect, it, vi } from "vitest";
import { report } from "@punyts/core";
import { createStore, type Store } from "@punyts/state";
import { copyJson } from "../Apply.js";
import { createStoreBridge } from "../Bridge.js";
import type { Change } from "../Change.js";
import { createSyncClient, type SyncClient } from "../Client.js";
import type { SyncMessage } from "../Messages.js";
import { createInProcessTransport, settle } from "../__fixtures__/InProcessTransport.js";
import { createAuthority, type AuthorityOptions, type ChangeContext } from "./Authority.js";
import { createMemoryNamespaceStorage } from "./NamespaceStorage.js";

vi.mock("@punyts/core", async (original) => ({ ...(await original<typeof import("@punyts/core")>()), report: vi.fn() }));

const NAMESPACE = "apps.expenses";
const SERVER_KEY = new Uint8Array(32).fill(7);

const STATE = Object.freeze({
    app: Object.freeze({ page: 1 }),
    data: Object.freeze({ total: 0, expenses: Object.freeze({}) }),
    server: Object.freeze({ apiKey: "secret-key" })
});

const hello = (revision = 0) => JSON.stringify({ type: "hello", namespace: NAMESPACE, revision, clientId: "tab-1", protocol: 1 });

let counter = 0;
const change = (path: string, value: unknown, base = 0, op: Change["op"] = "set", id = `id-${++counter}`) =>
    JSON.stringify({ type: "change", change: value === undefined ? { id, path, op, base } : { id, path, op, value, base } });

const setup = async (options: Partial<AuthorityOptions> = {}) => {
    const storage = createMemoryNamespaceStorage();
    const authority = await createAuthority({ namespace: NAMESPACE, storage, initial: copyJson(STATE), serverKey: SERVER_KEY, ...options });
    const join = (revision?: number) => {
        const received: SyncMessage[] = [];
        const session = authority.connect({ send: (text) => received.push(JSON.parse(text)), close: vi.fn() });
        if (revision !== undefined) {
            session.receive(hello(revision));
        }
        return { received, session };
    };
    return { authority, storage, join };
};

afterEach(() => {
    vi.mocked(report).mockClear();
});

describe("server logic", () => {
    describe("change handlers", () => {
        it("should adjust a change: ack adjusted with the value and push the adjusted value", async () => {
            const { authority, join } = await setup();
            authority.onChange("$.data.expenses.*", ({ change }) => {
                const expense = change.value as { amount: number };
                return { result: "adjust", value: { ...expense, amount: Math.round(expense.amount) } };
            });
            const writer = join(0);
            const reader = join(0);

            writer.session.receive(change("$.data.expenses.e1", { amount: 12.6 }, 0, "set", "x"));

            expect(authority.state()).toMatchObject({ data: { expenses: { e1: { amount: 13 } } } });
            expect(writer.received.at(-1)).toEqual({ type: "ack", id: "x", result: "adjusted", revision: 1, value: { amount: 13 } });
            expect(reader.received.at(-1)).toEqual({
                type: "changes",
                changes: [{ id: "x", path: "$.data.expenses.e1", op: "set", value: { amount: 13 }, base: 0, revision: 1 }]
            });
        });

        it("should reject a change with the handler's reason and apply nothing", async () => {
            const { authority, join } = await setup();
            authority.onChange("$.data.expenses.*", ({ change }) =>
                (change.value as { amount: number }).amount < 0 ? { result: "reject", reason: "amount must be positive" } : undefined);
            const writer = join(0);
            const reader = join(0);

            writer.session.receive(change("$.data.expenses.e1", { amount: -5 }, 0, "set", "x"));
            writer.session.receive(change("$.data.expenses.e2", { amount: 5 }, 0, "set", "y"));

            expect(writer.received.slice(-2)).toEqual([
                { type: "ack", id: "x", result: "rejected", reason: "amount must be positive" },
                { type: "ack", id: "y", result: "applied", revision: 1 }
            ]);
            expect(authority.state()).toMatchObject({ data: { expenses: { e2: { amount: 5 } } } });
            expect(reader.received.filter((message) => message.type === "changes")).toHaveLength(1);
        });

        it("should run handlers in registration order on the change as adjusted, the first reject winning", async () => {
            const { authority, join } = await setup();
            const seen: unknown[] = [];
            authority.onChange("$.data.*", ({ change }) => {
                seen.push(change.value);
                return { result: "adjust", value: 2 };
            });
            authority.onChange("$.data.total", ({ change }) => {
                seen.push(change.value);
                return { result: "reject", reason: "first" };
            });
            authority.onChange("$.data.total", () => ({ result: "reject", reason: "second" }));
            const writer = join(0);

            writer.session.receive(change("$.data.total", 1, 0, "set", "x"));

            expect(seen).toEqual([1, 2]);
            expect(writer.received.at(-1)).toEqual({ type: "ack", id: "x", result: "rejected", reason: "first" });
            expect(authority.revision()).toBe(0);
        });

        it("should only call handlers whose pattern touches the change", async () => {
            const { authority, join } = await setup();
            const expenses = vi.fn();
            authority.onChange("$.data.expenses.*", expenses);
            const writer = join(0);

            writer.session.receive(change("$.app.page", 2));
            writer.session.receive(change("$.data", { total: 1, expenses: {} }));

            expect(expenses).toHaveBeenCalledTimes(1);
            expect(expenses.mock.calls[0][0].change.path).toBe("$.data");
        });

        it("should tell a handler a change is stale and give it the changes since its base", async () => {
            const { authority, join } = await setup();
            const contexts: ChangeContext[] = [];
            authority.onChange("$.data.total", (context) => {
                contexts.push(context);
                return undefined;
            });
            const first = join(0);
            const second = join(0);
            first.session.receive(change("$.data.total", 10, 0, "set", "a"));
            first.session.receive(change("$.app.page", 2, 1, "set", "b"));

            second.session.receive(change("$.data.total", 20, 0, "set", "c"));
            second.session.receive(change("$.data.total", 30, 3, "set", "d"));

            expect(contexts.map(({ change, stale, since, clientId }) => ({ id: change.id, stale, since: since.map((logged) => logged.id), clientId }))).toEqual([
                { id: "a", stale: false, since: [], clientId: "tab-1" },
                { id: "c", stale: true, since: ["a", "b"], clientId: "tab-1" },
                { id: "d", stale: false, since: [], clientId: "tab-1" }
            ]);
            expect(contexts[1].get("$.data.total")).toBe(30);
        });

        it("should count a change as stale when its base is older than the log", async () => {
            const { authority, join } = await setup({ logLength: 1 });
            const stale = vi.fn();
            authority.onChange("$.app.page", ({ stale: isStale }) => {
                stale(isStale);
                return undefined;
            });
            const writer = join(0);
            writer.session.receive(change("$.data.total", 1));
            writer.session.receive(change("$.data.total", 2));

            writer.session.receive(change("$.app.page", 5, 0));

            expect(stale).toHaveBeenCalledWith(true);
        });

        it("should give a handler a copy it cannot change the state through", async () => {
            const { authority, join } = await setup();
            authority.onChange("$.data.*", ({ change, get }) => {
                (change as { value: unknown }).value = 99;
                (get("$.data") as { total: number }).total = 99;
                return undefined;
            });
            const writer = join(0);

            writer.session.receive(change("$.data.total", 1));

            expect(authority.state()).toMatchObject({ data: { total: 1 } });
        });

        it("should reject a change when a handler throws and report it", async () => {
            const { authority, join } = await setup();
            authority.onChange("$.data.*", () => {
                throw new Error("boom");
            });
            const writer = join(0);

            writer.session.receive(change("$.data.total", 1, 0, "set", "x"));

            expect(writer.received.at(-1)).toEqual({ type: "ack", id: "x", result: "rejected", reason: "server logic failed" });
            expect(vi.mocked(report).mock.calls.some(([, message]) => message.startsWith("A change handler"))).toBe(true);
        });

        it("should stop calling a handler once it is removed", async () => {
            const { authority, join } = await setup();
            const handler = vi.fn();
            const remove = authority.onChange("$.data.*", handler);
            const writer = join(0);

            remove();
            writer.session.receive(change("$.data.total", 1));

            expect(handler).not.toHaveBeenCalled();
        });

        it("should reject an adjusted delete when the parent does not exist", async () => {
            const { authority, join } = await setup();
            authority.onChange("$.data.*", () => ({ result: "adjust", value: 1 }));
            const writer = join(0);

            writer.session.receive(change("$.data.missing.total", undefined, 0, "delete", "x"));

            expect(writer.received.at(-1)).toEqual({ type: "ack", id: "x", result: "rejected", reason: "$.data.missing does not exist" });
        });
    });

    describe("server writes", () => {
        it("should give a server write the next revision and push it to every client", async () => {
            const { authority, join } = await setup();
            const one = join(0);
            const two = join(0);

            const revision = authority.write({ path: "$.data.total", op: "set", value: 42 });

            expect(revision).toBe(1);
            expect(authority.state()).toMatchObject({ data: { total: 42 } });
            for (const client of [one, two]) {
                expect(client.received.at(-1)).toMatchObject({ type: "changes", changes: [{ path: "$.data.total", op: "set", value: 42, base: 0, revision: 1 }] });
            }
        });

        it("should log server writes for catching clients up", async () => {
            const { authority, join } = await setup();
            authority.write({ path: "$.data.total", op: "set", value: 1 });
            authority.write({ path: "$.app.page", op: "set", value: 2 });

            const client = join(1);

            expect(client.received[0]).toMatchObject({ revision: 2, changes: [{ path: "$.app.page", revision: 2 }] });
        });

        it("should let a handler write while it decides", async () => {
            const { authority, join } = await setup();
            authority.onChange("$.data.expenses.*", ({ change, get }) => {
                const expenses = { ...(get("$.data.expenses") as object), [change.path.split(".").at(-1)!]: change.value };
                const total = Object.values(expenses as Record<string, { amount: number }>).reduce((sum, { amount }) => sum + amount, 0);
                authority.write({ path: "$.data.total", op: "set", value: total });
                return undefined;
            });
            const writer = join(0);
            const reader = join(0);

            writer.session.receive(change("$.data.expenses.e1", { amount: 7 }));

            expect(authority.state()).toMatchObject({ data: { total: 7, expenses: { e1: { amount: 7 } } } });
            expect(reader.received.filter((message) => message.type === "changes").map((message) => message.type === "changes" && message.changes[0].revision)).toEqual([1, 2]);
        });

        it("should throw for a path that is not a sync path or a missing parent", async () => {
            const { authority } = await setup();

            expect(() => authority.write({ path: "$.runtime.x", op: "set", value: 1 })).toThrow("$.runtime.x is not a sync path");
            expect(() => authority.write({ path: "$.data.missing.x", op: "set", value: 1 })).toThrow("$.data.missing does not exist");
            expect(authority.revision()).toBe(0);
        });

        it("should push the writes of writeAll to every client in one changes message", async () => {
            const { authority, join } = await setup();
            const client = join(0);

            const revisions = authority.writeAll([
                { path: "$.data.expenses.e1", op: "set", value: { amount: 3 } },
                { path: "$.server.token", op: "set", value: "t" },
                { path: "$.data.total", op: "set", value: 3 }
            ]);

            expect(revisions).toEqual([1, undefined, 2]);
            const pushes = client.received.filter((message) => message.type === "changes");
            expect(pushes).toHaveLength(1);
            expect(pushes[0]).toMatchObject({ changes: [{ path: "$.data.expenses.e1", revision: 1 }, { path: "$.data.total", revision: 2 }] });
        });

        it("should write nothing from writeAll when one path is not a sync path", async () => {
            const { authority, join } = await setup();
            const client = join(0);

            expect(() => authority.writeAll([
                { path: "$.data.total", op: "set", value: 5 },
                { path: "$.runtime.x", op: "set", value: 1 }
            ])).toThrow("$.runtime.x is not a sync path");

            expect(authority.revision()).toBe(0);
            expect(client.received.filter((message) => message.type === "changes")).toEqual([]);
        });

        it("should read a copy of one path with get", async () => {
            const { authority } = await setup();

            const expenses = authority.get("$.data.expenses") as Record<string, unknown>;
            expenses["e9"] = { amount: 1 };

            expect(authority.get("$.data.total")).toBe(0);
            expect(authority.get("$.server.apiKey")).toBe("secret-key");
            expect(authority.get("$.data.missing")).toBeUndefined();
            expect(authority.get("$.data.expenses")).toEqual({});
        });
    });

    describe("after-apply handlers", () => {
        it("should call onApplied after the ack with the change as applied and the client id", async () => {
            const { authority, join } = await setup();
            authority.onChange("$.data.total", () => ({ result: "adjust", value: 9 }));
            const writer = join(0);
            const seen: unknown[] = [];
            authority.onApplied((applied, clientId) => {
                seen.push({ applied, clientId, acked: writer.received.some((message) => message.type === "ack") });
            });

            writer.session.receive(change("$.data.total", 5));

            expect(seen).toEqual([{ applied: expect.objectContaining({ path: "$.data.total", value: 9, revision: 1 }), clientId: "tab-1", acked: true }]);
        });

        it("should not call onApplied for a rejected change and stop once removed", async () => {
            const { authority, join } = await setup();
            const handler = vi.fn();
            const remove = authority.onApplied(handler);
            const writer = join(0);

            writer.session.receive(change("$.server.apiKey", "x"));
            remove();
            writer.session.receive(change("$.data.total", 1));

            expect(handler).not.toHaveBeenCalled();
        });

        it("should let an after-apply handler write and report one that throws", async () => {
            const { authority, join } = await setup();
            authority.onApplied(() => {
                throw new Error("boom");
            });
            authority.onApplied((applied) => {
                if (applied.path === "$.data.total") authority.write({ path: "$.app.page", op: "set", value: 2 });
            });
            const writer = join(0);

            writer.session.receive(change("$.data.total", 1));

            expect(authority.state()).toMatchObject({ app: { page: 2 }, data: { total: 1 } });
            expect(report).toHaveBeenCalledWith("state-sync", expect.stringContaining("after a change"), [NAMESPACE, "boom"]);
        });
    });

    describe("$.server", () => {
        it("should apply and save a server write under $.server without a revision or a push", async () => {
            const { authority, storage, join } = await setup();
            const client = join(0);

            const revision = authority.write({ path: "$.server.token", op: "set", value: "secret-token" });
            await authority.flush();

            expect(revision).toBeUndefined();
            expect(authority.revision()).toBe(0);
            expect(authority.state()).toMatchObject({ server: { apiKey: "secret-key", token: "secret-token" } });
            expect(await storage.load(NAMESPACE)).toMatchObject({ revision: 0, log: [] });
            expect(await createAuthority({ namespace: NAMESPACE, storage, serverKey: SERVER_KEY }).then((loaded) => loaded.state())).toMatchObject({ server: { token: "secret-token" } });
            expect(client.received).toHaveLength(1);
        });

        it("should never send $.server in a welcome, a push or an ack", async () => {
            const { authority, join } = await setup();
            authority.onChange("$.data.*", ({ get }) => ({ result: "adjust", value: String(get("$.server.apiKey")).length }));
            const writer = join(0);
            authority.write({ path: "$.server.token", op: "set", value: "secret-token" });
            writer.session.receive(change("$.data.total", 1));
            authority.write({ path: "$.data.note", op: "set", value: "n" });
            authority.emit("saved");

            const late = join(0);
            const caughtUp = join(1);

            const sent = JSON.stringify([writer.received, late.received, caughtUp.received]);
            expect(sent).not.toContain("secret");
            expect(sent).not.toContain("$.server");
            expect(late.received[0]).toMatchObject({ snapshot: { app: { page: 1 }, data: { total: 10, note: "n" } } });
            expect(late.received[0]).not.toHaveProperty("snapshot.server");
        });

        it("should reject a client change at or below $.server without calling handlers", async () => {
            const { authority, join } = await setup();
            const handler = vi.fn();
            authority.onChange("$.*", handler);
            const writer = join(0);

            writer.session.receive(change("$.server", { apiKey: "mine" }, 0, "set", "x"));
            writer.session.receive(change("$.server.apiKey", "mine", 0, "set", "y"));

            expect(writer.received.slice(-2)).toEqual([
                { type: "ack", id: "x", result: "rejected", reason: "$.server is server-only" },
                { type: "ack", id: "y", result: "rejected", reason: "$.server is server-only" }
            ]);
            expect(handler).not.toHaveBeenCalled();
            expect(authority.state()).toMatchObject({ server: { apiKey: "secret-key" } });
        });
    });

    describe("emit", () => {
        it("should hand a client's emit to the emit handlers and not apply it", async () => {
            const { authority, join } = await setup();
            const handler = vi.fn();
            authority.onEmit(handler);
            const client = join(0);

            client.session.receive(JSON.stringify({ type: "emit", name: "submit", value: { id: 1 } }));
            client.session.receive(JSON.stringify({ type: "emit", name: "ping" }));

            expect(handler.mock.calls).toEqual([["submit", { id: 1 }, "tab-1"], ["ping", undefined, "tab-1"]]);
            expect(authority.revision()).toBe(0);
        });

        it("should refuse an emit before hello and keep going when a handler throws", async () => {
            const { authority, join } = await setup();
            const after = vi.fn();
            authority.onEmit(() => {
                throw new Error("boom");
            });
            const remove = authority.onEmit(after);
            const early = join();
            const client = join(0);

            early.session.receive(JSON.stringify({ type: "emit", name: "submit" }));
            client.session.receive(JSON.stringify({ type: "emit", name: "submit" }));
            remove();
            client.session.receive(JSON.stringify({ type: "emit", name: "again" }));

            expect(early.received).toEqual([{ type: "error", code: "no-hello", message: "send hello first" }]);
            expect(after.mock.calls).toEqual([["submit", undefined, "tab-1"]]);
            expect(vi.mocked(report).mock.calls.some(([, message]) => message.startsWith("An emit handler"))).toBe(true);
        });

        it("should send the authority's emit to every welcomed client", async () => {
            const { authority, join } = await setup();
            const one = join(0);
            const waiting = join();

            authority.emit("notice", { text: "hi" });

            expect(one.received.at(-1)).toEqual({ type: "emit", name: "notice", value: { text: "hi" } });
            expect(waiting.received).toEqual([]);
        });
    });

    describe("with sync clients", () => {
        let clients: SyncClient[] = [];

        afterEach(() => {
            clients.forEach((client) => client.stop());
            clients = [];
        });

        const open = (transport: ReturnType<typeof createInProcessTransport>["transport"], onRejected = vi.fn()) => {
            const store: Store<any> = createStore({});
            const client = createSyncClient({ namespace: NAMESPACE, bridge: createStoreBridge(store), transport, backoff: () => 0, onRejected });
            clients.push(client);
            client.start();
            return { store, client, onRejected };
        };

        it("should show an adjusted value, fall back on a rejection and receive server writes", async () => {
            const { authority } = await setup();
            authority.onChange("$.data.expenses.*", ({ change }) => {
                const amount = (change.value as { amount: number }).amount;
                return amount < 0 ? { result: "reject", reason: "negative" } : { result: "adjust", value: { amount: Math.round(amount) } };
            });
            const { transport } = createInProcessTransport(authority);
            const one = open(transport);
            const two = open(transport);
            await settle();

            one.store.set("$.data.expenses.e1", { amount: 4.4 });
            one.store.set("$.data.expenses.e2", { amount: -1 });
            await settle();
            authority.write({ path: "$.data.total", op: "set", value: 4 });
            await settle();

            for (const { store, client } of [one, two]) {
                expect(store.get("$")).toEqual({ app: { page: 1 }, data: { total: 4, expenses: { e1: { amount: 4 } } } });
                expect(client.state()).toMatchObject({ revision: 2, outbox: [] });
            }
            expect(one.onRejected).toHaveBeenCalledWith({ path: "$.data.expenses.e2", reason: "negative" });
        });
    });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@punyts/state";
import { copyJson } from "./Apply.js";
import { createStoreBridge, type LocalChange, type StoreBridge } from "./Bridge.js";
import { createSyncClient, type SyncClient, type SyncClientOptions } from "./Client.js";
import type { ChangeMessage, SyncMessage } from "./Messages.js";
import type { SyncTransport } from "./Transport.js";
import { createFakeNetwork, type FakeAuthorityOptions } from "./__fixtures__/FakeNetwork.js";

const NAMESPACE = "apps.orders";

const STATE = Object.freeze({
    app: Object.freeze({ page: 1 }),
    data: Object.freeze({ total: 10, order: Object.freeze({ id: "k42", qty: 1 }) })
});

let clients: SyncClient[] = [];

afterEach(() => {
    clients.forEach((client) => client.stop());
    clients = [];
});

const setup = (authority: FakeAuthorityOptions = {}) => {
    const network = createFakeNetwork(NAMESPACE, { state: copyJson(STATE), ...authority });
    const connect = (extra: Partial<SyncClientOptions> = {}) => {
        const store: Store<any> = createStore({});
        const onStatus = vi.fn();
        const onRejected = vi.fn();
        const client = createSyncClient({
            namespace: NAMESPACE,
            bridge: createStoreBridge(store),
            transport: network.transport,
            backoff: () => 0,
            onStatus,
            onRejected,
            ...extra
        });
        clients.push(client);
        client.start();
        return { store, client, onStatus, onRejected };
    };
    return { network, connect };
};

const changeMessages = (received: SyncMessage[]) =>
    received.filter((message): message is ChangeMessage => message.type === "change");

describe("createSyncClient", () => {
    describe("connecting", () => {
        it("should send hello with the namespace, revision and client id", async () => {
            const { network, connect } = setup();
            connect({ clientId: "tab-1" });

            await network.settle();

            expect(network.received[0]).toEqual({ type: "hello", namespace: NAMESPACE, revision: 0, clientId: "tab-1", protocol: 1 });
        });

        it("should load the snapshot of welcome into the store and go online", async () => {
            const { network, connect } = setup({ snapshots: true });
            const { store, client, onStatus } = connect();

            await network.settle();

            expect(store.get("$")).toEqual(STATE);
            expect(client.status()).toEqual({ status: "online", waiting: 0, saveFailed: false });
            expect(onStatus.mock.calls.map((call) => call[0].status)).toEqual(["connecting", "online"]);
        });

        it("should apply the changes of welcome without sending them back", async () => {
            const { network, connect } = setup();
            const { store, client } = connect();
            await network.settle();
            network.goOffline();
            await network.settle();

            network.write({ path: "$.data", op: "set", value: { total: 5 } });
            network.write({ path: "$.app", op: "set", value: { page: 3 } });
            network.goOnline();
            await network.settle();

            expect(network.received.filter((message) => message.type === "hello").at(-1)).toMatchObject({ revision: 1 });
            expect(store.get("$")).toEqual({ data: { total: 5 }, app: { page: 3 } });
            expect(client.state().revision).toBe(3);
            expect(changeMessages(network.received)).toEqual([]);
        });

        it("should mount the initial state and outbox before connecting and send the outbox after welcome", async () => {
            const { network, connect } = setup({ snapshots: true });
            const initial = {
                state: copyJson<any>(STATE),
                revision: 0,
                outbox: [{ id: "c1", path: "$.data.total", op: "set" as const, value: 99, base: 0 }]
            };

            const { store } = connect({ initial });
            const mounted = copyJson(store.get("$.data.total"));
            await network.settle();

            expect(mounted).toBe(99);
            expect(network.store.get("$.data.total")).toBe(99);
            expect(store.get("$.data.total")).toBe(99);
        });
    });

    describe("changes", () => {
        it("should send a local change and confirm it on its ack", async () => {
            const { network, connect } = setup({ snapshots: true });
            const { store, client } = connect();
            await network.settle();

            store.set("$.data.total", 12);
            await network.settle();

            expect(network.store.get("$.data.total")).toBe(12);
            expect(client.state()).toMatchObject({ revision: 2, outbox: [], state: { data: { total: 12 } } });
        });

        it("should show another client's change and not send it back", async () => {
            const { network, connect } = setup({ snapshots: true });
            const first = connect();
            const second = connect();
            await network.settle();

            first.store.set("$.data.order.qty", 4);
            await network.settle();

            expect(second.store.get("$.data.order.qty")).toBe(4);
            expect(changeMessages(network.received)).toHaveLength(1);
            expect(second.client.state().revision).toBe(2);
        });

        it("should keep a waiting local change on top of a change from the authority", async () => {
            const { network, connect } = setup({ snapshots: true });
            const { store } = connect();
            await network.settle();

            store.set("$.data.order.qty", 9);
            network.write({ path: "$.data.order", op: "set", value: { id: "k99", qty: 1 } });
            await network.settle();

            expect(store.get("$.data.order")).toEqual({ id: "k99", qty: 9 });
            expect(network.store.get("$.data.order")).toEqual({ id: "k99", qty: 9 });
        });

        it("should give an emit from the authority to onEmit and send its own emits when online", async () => {
            const { network, connect } = setup();
            const onEmit = vi.fn();
            const { client } = connect({ onEmit });
            const before = client.emit("refresh");
            await network.settle();

            const after = client.emit("refresh", { page: 2 });
            network.emit("notice", "saved");
            await network.settle();

            expect(before).toBe(false);
            expect(after).toBe(true);
            expect(network.received).toContainEqual({ type: "emit", name: "refresh", value: { page: 2 } });
            expect(onEmit).toHaveBeenCalledWith("notice", "saved");
        });
    });

    describe("acks", () => {
        it("should restore the confirmed value and report a rejection", async () => {
            const { network, connect } = setup({
                snapshots: true,
                reject: (change) => change.path === "$.data.total" ? "total is locked" : undefined
            });
            const { store, client, onRejected } = connect();
            await network.settle();

            store.set("$.data.total", 50);
            await network.settle();

            expect(store.get("$.data.total")).toBe(10);
            expect(onRejected).toHaveBeenCalledWith({ path: "$.data.total", reason: "total is locked" });
            expect(client.status().waiting).toBe(0);
        });

        it("should show the adjusted value", async () => {
            const { network, connect } = setup({
                snapshots: true,
                adjust: (change) => change.path === "$.data.order.qty" ? 3 : undefined
            });
            const { store, client } = connect();
            await network.settle();

            store.set("$.data.order.qty", 300);
            await network.settle();

            expect(store.get("$.data.order.qty")).toBe(3);
            expect(client.state()).toMatchObject({ revision: 2, state: { data: { order: { qty: 3 } } } });
        });

        it("should not apply a change twice when it is resent after a lost ack", async () => {
            const { network, connect } = setup({ snapshots: true });
            const { store, client } = connect();
            await network.settle();
            network.loseNext((message) => message.type === "ack");

            store.set("$.data.total", 12);
            await network.settle();
            network.goOffline();
            await network.settle();
            network.goOnline();
            await network.settle();

            const sent = changeMessages(network.received);
            expect(sent).toHaveLength(2);
            expect(sent[0].change.id).toBe(sent[1].change.id);
            expect(network.revision()).toBe(2);
            expect(client.state()).toMatchObject({ revision: 2, outbox: [] });
            expect(store.get("$.data.total")).toBe(12);
        });

        it("should confirm a change from the catch-up when its ack was lost", async () => {
            const { network, connect } = setup();
            const { store, client } = connect();
            await network.settle();
            network.loseNext((message) => message.type === "ack");

            store.set("$.data.total", 12);
            await network.settle();
            network.goOffline();
            await network.settle();
            network.goOnline();
            await network.settle();

            expect(changeMessages(network.received)).toHaveLength(1);
            expect(network.revision()).toBe(2);
            expect(client.state()).toMatchObject({ revision: 2, outbox: [] });
        });
    });

    describe("offline", () => {
        it("should queue offline edits and send them in order on reconnect", async () => {
            const { network, connect } = setup({ snapshots: true });
            const { store, client, onStatus } = connect();
            await network.settle();
            network.goOffline();
            await network.settle();

            store.set("$.data.total", 11);
            await network.settle();
            store.set("$.app.page", 2);
            await network.settle();
            const offline = client.status();
            network.goOnline();
            await network.settle();

            expect(offline).toEqual({ status: "offline", waiting: 2, saveFailed: false });
            expect(changeMessages(network.received).map((message) => message.change.path)).toEqual(["$.data.total", "$.app.page"]);
            expect(network.store.get("$")).toMatchObject({ data: { total: 11 }, app: { page: 2 } });
            expect(client.status()).toEqual({ status: "online", waiting: 0, saveFailed: false });
            expect(onStatus).toHaveBeenCalledWith({ status: "offline", waiting: 2, saveFailed: false });
        });

        it("should fold queued changes to the same path into the last one and keep the order", async () => {
            const { network, connect } = setup({ snapshots: true });
            const { store, client } = connect();
            await network.settle();
            network.goOffline();
            await network.settle();

            store.set("$.data.total", 11);
            await network.settle();
            store.set("$.app.page", 2);
            await network.settle();
            store.set("$.data.total", 12);
            await network.settle();

            expect(client.state().outbox.map(({ path, value }) => [path, value])).toEqual([
                ["$.app.page", 2],
                ["$.data.total", 12]
            ]);
        });

        it("should drop a queued change below a path a later change replaces or deletes", async () => {
            const { network, connect } = setup({ snapshots: true });
            const { store, client } = connect();
            await network.settle();
            network.goOffline();
            await network.settle();

            store.set("$.data.order.qty", 2);
            await network.settle();
            store.set("$.app.page", 2);
            await network.settle();
            store.delete("$.data.order");
            await network.settle();

            expect(client.state().outbox.map(({ path, op }) => [path, op])).toEqual([
                ["$.app.page", "set"],
                ["$.data.order", "delete"]
            ]);
        });

        it("should keep a queued change below a later merge", async () => {
            const { network, connect } = setup();
            let push: (changes: LocalChange[]) => void = () => undefined;
            const bridge: StoreBridge = {
                load: vi.fn(),
                write: vi.fn(),
                subscribe: (onChanges) => {
                    push = onChanges;
                    return () => undefined;
                }
            };
            network.goOffline();
            const { client } = connect({ bridge });

            push([{ id: "a", path: "$.data.order.qty", op: "set", value: 2 }]);
            push([{ id: "b", path: "$.data.order", op: "merge", value: { note: "x" } }]);

            expect(client.state().outbox.map(({ id }) => id)).toEqual(["a", "b"]);
        });

        it("should show offline changes over the catch-up", async () => {
            const { network, connect } = setup();
            const { store } = connect();
            await network.settle();
            network.goOffline();
            await network.settle();

            store.set("$.data.order.qty", 9);
            await network.settle();
            network.write({ path: "$.data.order", op: "set", value: { id: "k99", qty: 1 } });
            network.goOnline();
            await network.settle();

            expect(store.get("$.data.order")).toEqual({ id: "k99", qty: 9 });
            expect(network.store.get("$.data.order")).toEqual({ id: "k99", qty: 9 });
        });

        it("should reconnect after a drop and count attempts from 0 again after welcome", async () => {
            const { network, connect } = setup();
            const backoff = vi.fn((_attempt: number) => 0);
            const { client, onStatus } = connect({ backoff });
            await network.settle();

            network.goOffline();
            await network.settle();
            network.goOnline();
            await network.settle();
            network.goOffline();
            await network.settle();

            expect(backoff.mock.calls.map((call) => call[0])).toEqual([0, 0]);
            expect(onStatus.mock.calls.map((call) => call[0].status)).toEqual([
                "connecting", "online", "offline", "connecting", "online", "offline"
            ]);
            expect(client.status().status).toBe("offline");
        });

        it("should wait longer between attempts by default", async () => {
            vi.useFakeTimers();
            try {
                //a transport that can never connect
                const transport: SyncTransport = {
                    connect: vi.fn((handlers) => {
                        queueMicrotask(handlers.onClose);
                        return { send: vi.fn(), close: vi.fn() };
                    })
                };
                const client = createSyncClient({ namespace: NAMESPACE, bridge: createStoreBridge(createStore({})), transport });
                clients.push(client);

                client.start();
                await vi.advanceTimersByTimeAsync(499);
                const before = vi.mocked(transport.connect).mock.calls.length;
                await vi.advanceTimersByTimeAsync(1);
                const afterFirst = vi.mocked(transport.connect).mock.calls.length;
                await vi.advanceTimersByTimeAsync(999);
                const beforeSecond = vi.mocked(transport.connect).mock.calls.length;
                await vi.advanceTimersByTimeAsync(1);

                expect([before, afterFirst, beforeSecond]).toEqual([1, 2, 2]);
                expect(transport.connect).toHaveBeenCalledTimes(3);
            }
            finally {
                vi.useRealTimers();
            }
        });
    });

    describe("catch-up", () => {
        it("should catch up again when a revision is skipped", async () => {
            const { network, connect } = setup();
            const { store, client } = connect();
            await network.settle();
            network.loseNext((message) => message.type === "changes");

            network.write({ path: "$.data.total", op: "set", value: 1 });
            network.write({ path: "$.data.total", op: "set", value: 2 });
            await network.settle();

            expect(network.received.filter((message) => message.type === "hello")).toHaveLength(2);
            expect(store.get("$.data.total")).toBe(2);
            expect(client.state().revision).toBe(3);
        });
    });

    describe("stop", () => {
        it("should close the connection and not reconnect", async () => {
            const { network, connect } = setup();
            const backoff = vi.fn((_attempt: number) => 0);
            const { store, client } = connect({ backoff });
            await network.settle();

            client.stop();
            store.set("$.data.total", 3);
            network.goOffline();
            await network.settle();

            expect(client.status()).toEqual({ status: "offline", waiting: 0, saveFailed: false });
            expect(backoff).not.toHaveBeenCalled();
            expect(changeMessages(network.received)).toEqual([]);
        });
    });
});

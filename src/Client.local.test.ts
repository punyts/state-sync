import { afterEach, describe, expect, it, vi } from "vitest";
import { report } from "@punyts/core";
import { createStore, type Store } from "@punyts/state";
import { copyJson } from "./Apply.js";
import { createStoreBridge } from "./Bridge.js";
import { createSyncClient, type SyncClient, type SyncClientOptions } from "./Client.js";
import { createMemoryLocalStore, type LocalStore } from "./LocalStore.js";
import { createFakeNetwork } from "./__fixtures__/FakeNetwork.js";

vi.mock("@punyts/core", async (original) => ({ ...(await original<typeof import("@punyts/core")>()), report: vi.fn() }));

const NAMESPACE = "apps.orders";

const STATE = Object.freeze({
    app: Object.freeze({ page: 1 }),
    data: Object.freeze({ total: 10 })
});

let clients: SyncClient[] = [];

afterEach(() => {
    clients.forEach((client) => client.stop());
    clients = [];
    vi.mocked(report).mockClear();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const open = (options: Omit<SyncClientOptions, "namespace" | "bridge">) => {
    const store: Store<any> = createStore({});
    const onStatus = vi.fn();
    const client = createSyncClient({ namespace: NAMESPACE, bridge: createStoreBridge(store), backoff: () => 0, onStatus, ...options });
    clients.push(client);
    client.start();
    return { store, client, onStatus };
};

/** A local store whose writes fail while full is set */
const createFullableStore = () => {
    const inner = createMemoryLocalStore();
    const control = { full: false };
    const local: LocalStore = {
        ...inner,
        write: (namespace, part, value) => {
            if (control.full) {
                const error = new Error("the quota is used up");
                error.name = "QuotaExceededError";
                throw error;
            }
            inner.write(namespace, part, value);
        }
    };
    return { local, control };
};

describe("createSyncClient with a local store", () => {
    describe("connected", () => {
        it("should save the confirmed state with its revision and the outbox", async () => {
            const network = createFakeNetwork(NAMESPACE, { state: copyJson(STATE) });
            const localStore = createMemoryLocalStore();
            const { store } = open({ transport: network.transport, localStore });
            await network.settle();

            network.goOffline();
            await network.settle();
            store.set("$.data.total", 12);
            await tick();

            expect(localStore.read(NAMESPACE, "confirmed")).toEqual({ state: STATE, revision: 1 });
            expect(localStore.read(NAMESPACE, "outbox")).toMatchObject([{ path: "$.data.total", op: "set", value: 12, base: 1 }]);
        });

        it("should mount what the local store holds on start, before connecting", async () => {
            const network = createFakeNetwork(NAMESPACE, { state: copyJson(STATE) });
            const localStore = createMemoryLocalStore();
            const first = open({ transport: network.transport, localStore });
            await network.settle();
            network.goOffline();
            await network.settle();
            first.store.set("$.data.total", 12);
            await tick();
            first.client.stop();

            const { store, client } = open({ transport: network.transport, localStore, initial: { state: {}, revision: 0, outbox: [] } });
            const mounted = copyJson(store.get("$"));

            expect(mounted).toEqual({ app: { page: 1 }, data: { total: 12 } });
            expect(client.state()).toMatchObject({ revision: 1, outbox: [{ path: "$.data.total", value: 12 }] });
        });

        it("should send a saved outbox after a reload and clear it on its ack", async () => {
            const network = createFakeNetwork(NAMESPACE, { state: copyJson(STATE) });
            const localStore = createMemoryLocalStore();
            const first = open({ transport: network.transport, localStore });
            await network.settle();
            network.goOffline();
            await network.settle();
            first.store.set("$.data.total", 12);
            await tick();
            first.client.stop();

            network.goOnline();
            open({ transport: network.transport, localStore });
            await network.settle();

            expect(network.store.get("$.data.total")).toBe(12);
            expect(localStore.read(NAMESPACE, "confirmed")).toEqual({ state: { app: { page: 1 }, data: { total: 12 } }, revision: 2 });
            expect(localStore.read(NAMESPACE, "outbox")).toEqual([]);
        });

        it("should save changes from the authority", async () => {
            const network = createFakeNetwork(NAMESPACE, { state: copyJson(STATE) });
            const localStore = createMemoryLocalStore();
            open({ transport: network.transport, localStore });
            await network.settle();

            network.write({ path: "$.app.page", op: "set", value: 4 });
            await network.settle();

            expect(localStore.read(NAMESPACE, "confirmed")).toEqual({ state: { app: { page: 4 }, data: { total: 10 } }, revision: 2 });
        });

        it("should skip saved parts and changes that are not valid", () => {
            const localStore = createMemoryLocalStore();
            localStore.write(NAMESPACE, "confirmed", { state: copyJson(STATE), revision: 2 });
            localStore.write(NAMESPACE, "outbox", [
                { id: "c1", path: "$.data.total", op: "set", value: 3, base: 2 },
                { id: "c2", path: "$.runtime.x", op: "set", value: 1, base: 2 },
                "junk"
            ]);

            const { client } = open({ transport: createFakeNetwork(NAMESPACE).transport, localStore });

            expect(client.state().outbox.map((change) => change.id)).toEqual(["c1"]);
            expect(vi.mocked(report).mock.calls.filter(([, message]) => message.startsWith("Ignoring a saved change"))).toHaveLength(2);
        });

        it("should fall back to the initial state when the saved state is not valid", () => {
            const localStore = createMemoryLocalStore();
            localStore.write(NAMESPACE, "confirmed", { state: [], revision: -1 });

            const { store } = open({
                transport: createFakeNetwork(NAMESPACE).transport,
                localStore,
                initial: { state: copyJson<any>(STATE), revision: 1, outbox: [] }
            });

            expect(store.get("$")).toEqual(STATE);
        });
    });

    describe("save failures", () => {
        it("should report a failed save, keep running in memory and clear the flag on the next good save", async () => {
            const network = createFakeNetwork(NAMESPACE, { state: copyJson(STATE) });
            const { local, control } = createFullableStore();
            const { store, client, onStatus } = open({ transport: network.transport, localStore: local });
            await network.settle();

            control.full = true;
            store.set("$.data.total", 12);
            await network.settle();
            const failed = client.status();
            const kept = copyJson(store.get("$.data.total"));
            const reported = vi.mocked(report).mock.calls.some(([category, message]) => category === "state-sync" && message.startsWith("Could not save"));

            control.full = false;
            store.set("$.data.total", 13);
            await network.settle();

            expect(failed.saveFailed).toBe(true);
            expect(kept).toBe(12);
            expect(reported).toBe(true);
            expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ saveFailed: true }));
            expect(client.status().saveFailed).toBe(false);
            expect(local.read(NAMESPACE, "confirmed")).toMatchObject({ state: { data: { total: 13 } }, revision: 3 });
        });

        it("should save what is pending on stop", () => {
            const localStore = createMemoryLocalStore();
            const { store, client } = open({ localStore, initial: { state: copyJson<any>(STATE), revision: 0, outbox: [] } });

            store.set("$.data.total", 7);
            //the store batches to a microtask; flush it by stopping after it ran
            return Promise.resolve().then(() => {
                client.stop();
                expect(localStore.read(NAMESPACE, "confirmed")).toMatchObject({ state: { data: { total: 7 } } });
            });
        });
    });

    describe("standalone", () => {
        it("should report standalone and not connect", () => {
            const { client, onStatus } = open({ localStore: createMemoryLocalStore() });

            expect(client.status()).toEqual({ status: "standalone", waiting: 0, saveFailed: false });
            expect(onStatus).toHaveBeenCalledWith({ status: "standalone", waiting: 0, saveFailed: false });
            expect(client.emit("ping")).toBe(false);
        });

        it("should confirm local changes at once and keep them across a reload", async () => {
            const localStore = createMemoryLocalStore();
            const first = open({ localStore, initial: { state: copyJson<any>(STATE), revision: 0, outbox: [] } });

            first.store.set("$.data.total", 21);
            first.store.set("$.app", { page: 2 });
            await tick();
            first.client.stop();
            const { store, client } = open({ localStore, initial: { state: copyJson<any>(STATE), revision: 0, outbox: [] } });

            expect(store.get("$")).toEqual({ app: { page: 2 }, data: { total: 21 } });
            expect(client.state().outbox).toEqual([]);
            expect(localStore.read(NAMESPACE, "outbox")).toBeUndefined();
        });

        it("should confirm an outbox a connected run left", async () => {
            const localStore = createMemoryLocalStore();
            localStore.write(NAMESPACE, "confirmed", { state: copyJson(STATE), revision: 4 });
            localStore.write(NAMESPACE, "outbox", [{ id: "c1", path: "$.data.total", op: "set", value: 3, base: 4 }]);

            const { store, client } = open({ localStore });
            await tick();

            expect(store.get("$.data.total")).toBe(3);
            expect(client.state()).toEqual({ state: { app: { page: 1 }, data: { total: 3 } }, revision: 4, outbox: [] });
            expect(localStore.read(NAMESPACE, "outbox")).toEqual([]);
            expect(localStore.read(NAMESPACE, "confirmed")).toEqual({ state: { app: { page: 1 }, data: { total: 3 } }, revision: 4 });
        });

        it("should run without a local store", async () => {
            const { store, client } = open({ initial: { state: copyJson<any>(STATE), revision: 0, outbox: [] } });

            store.set("$.data.total", 5);
            await tick();

            expect(client.state().state).toMatchObject({ data: { total: 5 } });
        });
    });
});

describe("createSyncClient when the namespace is revoked", () => {
    it("should delete every part of the namespace, stop, and say why", async () => {
        const network = createFakeNetwork(NAMESPACE, { state: copyJson(STATE) });
        const localStore = createMemoryLocalStore();
        localStore.write(NAMESPACE, "document", { screens: {} });
        localStore.write("apps.other", "confirmed", { state: {}, revision: 1 });
        const onRevoked = vi.fn();
        const { store, client } = open({ transport: network.transport, localStore, onRevoked });
        await network.settle();
        network.goOffline();
        await network.settle();
        store.set("$.data.total", 12);
        await tick();
        expect(localStore.read(NAMESPACE, "outbox")).toHaveLength(1);

        network.revoke("This app is no longer shared with you");
        network.goOnline();
        await network.settle();
        store.set("$.data.total", 13);
        await network.settle();
        client.stop();
        client.start();
        await network.settle();

        expect(onRevoked).toHaveBeenCalledTimes(1);
        expect(onRevoked).toHaveBeenCalledWith("This app is no longer shared with you");
        for (const part of ["confirmed", "outbox", "document"] as const) expect(localStore.read(NAMESPACE, part)).toBeUndefined();
        expect(localStore.read("apps.other", "confirmed")).toEqual({ state: {}, revision: 1 });
        expect(client.state().outbox).toEqual([]);
        expect(client.status().status).toBe("offline");
        expect(network.received.filter((message) => message.type === "hello")).toHaveLength(2);
        expect(network.received.filter((message) => message.type === "change")).toHaveLength(0);
    });

    it("should be revoked while online, before a pending save is written", async () => {
        const network = createFakeNetwork(NAMESPACE, { state: copyJson(STATE) });
        const localStore = createMemoryLocalStore();
        const onRevoked = vi.fn();
        const { client } = open({ transport: network.transport, localStore, onRevoked });
        await network.settle();
        expect(client.status().status).toBe("online");

        network.revoke("Revoked");
        await network.settle();

        expect(onRevoked).toHaveBeenCalledWith("Revoked");
        expect(localStore.read(NAMESPACE, "confirmed")).toBeUndefined();
        expect(network.received.filter((message) => message.type === "hello")).toHaveLength(1);
    });
});

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "@punyts/state";
import { copyJson } from "./Apply.js";
import { createStoreBridge } from "./Bridge.js";
import { createSyncClient, type SyncClient, type SyncClientOptions } from "./Client.js";
import { createWebLocalStore } from "./LocalStore.js";
import { createFakeNetwork } from "./__fixtures__/FakeNetwork.js";

const NAMESPACE = "apps.orders";
const FILLER = "filler";

const STATE = Object.freeze({
    app: Object.freeze({ page: 1 }),
    data: Object.freeze({ total: 10 })
});

let clients: SyncClient[] = [];

beforeEach(() => localStorage.clear());

afterEach(() => {
    clients.forEach((client) => client.stop());
    clients = [];
    localStorage.clear();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A page load: a new store and client over the same localStorage */
const load = (options: Omit<SyncClientOptions, "namespace" | "bridge" | "localStore"> = {}) => {
    const store: Store<any> = createStore({});
    const client = createSyncClient({
        namespace: NAMESPACE,
        bridge: createStoreBridge(store),
        localStore: createWebLocalStore(),
        backoff: () => 0,
        initial: { state: copyJson<any>(STATE), revision: 0, outbox: [] },
        ...options
    });
    clients.push(client);
    client.start();
    return { store, client };
};

/** Fills localStorage until a write throws, leaving the given room */
const fillStorage = (room: number) => {
    let chunk = "x".repeat(1024 * 1024);
    let index = 0;
    while (chunk.length > 0) {
        try {
            localStorage.setItem(`${FILLER}:${index}`, chunk);
            index++;
        }
        catch {
            chunk = chunk.slice(0, Math.floor(chunk.length / 2));
        }
        if (chunk.length < room) {
            break;
        }
    }
};

describe("the sync client over localStorage in Chromium", () => {
    it("should restore the confirmed state and the outbox after a reload and send the outbox", async () => {
        const network = createFakeNetwork(NAMESPACE, { state: copyJson(STATE) });
        const first = load({ transport: network.transport });
        await network.settle();
        network.goOffline();
        await network.settle();
        first.store.set("$.data.total", 12);
        await tick();
        first.client.stop();

        const reloaded = load({ transport: network.transport });
        const mounted = copyJson(reloaded.store.get("$"));
        network.goOnline();
        await network.settle();

        expect(mounted).toEqual({ app: { page: 1 }, data: { total: 12 } });
        expect(network.store.get("$.data.total")).toBe(12);
        expect(reloaded.client.state()).toMatchObject({ revision: 2, outbox: [] });
        expect(JSON.parse(localStorage.getItem(`punyts.sync:${NAMESPACE}:outbox`)!)).toEqual([]);
    });

    it("should keep standalone changes across a reload", async () => {
        const first = load();
        first.store.set("$.data.total", 21);
        first.store.set("$.app.page", 3);
        await tick();
        first.client.stop();

        const { store, client } = load();

        expect(client.status().status).toBe("standalone");
        expect(store.get("$")).toEqual({ app: { page: 3 }, data: { total: 21 } });
    });

    it("should report a quota error and keep the state in memory", async () => {
        const { store, client } = load();
        store.set("$.data.total", 11);
        await tick();
        fillStorage(16);

        store.set("$.data", { total: 12, notes: "n".repeat(64 * 1024) });
        await tick();
        const failed = client.status();
        const saved = JSON.parse(localStorage.getItem(`punyts.sync:${NAMESPACE}:confirmed`)!);

        expect(failed.saveFailed).toBe(true);
        expect(store.get("$.data.total")).toBe(12);
        expect(client.state().state).toMatchObject({ data: { total: 12 } });
        expect(saved).toMatchObject({ state: { data: { total: 11 } } });
    });
});

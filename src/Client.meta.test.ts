import { afterEach, describe, expect, it, vi } from "vitest";
import { report } from "@punyts/core";
import { createStore, type Store } from "@punyts/state";
import { copyJson } from "./Apply.js";
import { createStoreBridge } from "./Bridge.js";
import { createSyncClient, type SyncClient, type SyncClientOptions } from "./Client.js";
import { createMemoryLocalStore } from "./LocalStore.js";
import { createFakeNetwork } from "./__fixtures__/FakeNetwork.js";

vi.mock("@punyts/core", async (original) => ({ ...(await original<typeof import("@punyts/core")>()), report: vi.fn() }));

const NAMESPACE = "apps.board";
const STATE = { app: { panel: { open: false }, password: { value: "" } }, data: { total: 1 } };

let clients: SyncClient[] = [];

afterEach(() => {
    clients.forEach((client) => client.stop());
    clients = [];
    vi.mocked(report).mockClear();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const open = (options: Omit<SyncClientOptions, "namespace" | "bridge">) => {
    const store: Store<any> = createStore({});
    const client = createSyncClient({ namespace: NAMESPACE, bridge: createStoreBridge(store), backoff: () => 0, ...options });
    clients.push(client);
    client.start();
    return { store, client };
};

const sentPaths = (network: ReturnType<typeof createFakeNetwork>) =>
    network.received.flatMap((message) => (message.type === "change" ? [message.change.path] : []));

describe("createSyncClient with local and secret paths", () => {
    it("should keep a change at a local path on the device and never send it", async () => {
        // Arrange
        const network = createFakeNetwork(NAMESPACE, { state: copyJson(STATE) });
        const localStore = createMemoryLocalStore();
        const { store } = open({ transport: network.transport, localStore, local: ["$.app.panel.open"] });
        await network.settle();

        // Act
        store.set("$.app.panel.open", true);
        store.set("$.data.total", 2);
        await network.settle();

        // Assert
        expect(sentPaths(network)).toEqual(["$.data.total"]);
        expect(localStore.read(NAMESPACE, "local")).toMatchObject([{ path: "$.app.panel.open", op: "set", value: true }]);
        expect(store.get("$.app.panel.open")).toBe(true);
    });

    it("should lay the device's local changes over the state it mounts on the next start", async () => {
        // Arrange
        const network = createFakeNetwork(NAMESPACE, { state: copyJson(STATE) });
        const localStore = createMemoryLocalStore();
        const first = open({ transport: network.transport, localStore, local: ["$.app.panel.open"] });
        await network.settle();
        first.store.set("$.app.panel.open", true);
        await network.settle();
        first.client.stop();

        // Act
        const second = open({ transport: network.transport, localStore, local: ["$.app.panel.open"] });
        await network.settle();

        // Assert
        expect(second.store.get("$.app.panel.open")).toBe(true);
    });

    it("should send a secret change while online and never write it to the local store", async () => {
        // Arrange
        const network = createFakeNetwork(NAMESPACE, { state: copyJson(STATE) });
        const localStore = createMemoryLocalStore();
        const { store, client } = open({ transport: network.transport, localStore, secret: ["$.app.password.value"] });
        await network.settle();

        // Act
        store.set("$.app.password.value", "hunter2");
        await tick();
        const kept = JSON.stringify([localStore.read(NAMESPACE, "outbox"), localStore.read(NAMESPACE, "confirmed"), client.state()]);
        await network.settle();

        // Assert
        expect(sentPaths(network)).toEqual(["$.app.password.value"]);
        expect(kept).not.toContain("hunter2");
        expect(JSON.stringify([localStore.read(NAMESPACE, "outbox"), localStore.read(NAMESPACE, "confirmed")])).not.toContain("hunter2");
    });

    it("should take local paths set after start from the next change on", async () => {
        // Arrange
        const network = createFakeNetwork(NAMESPACE, { state: copyJson(STATE) });
        const { store, client } = open({ transport: network.transport });
        await network.settle();

        // Act
        client.setPaths({ local: ["$.app.panel"] });
        store.set("$.app.panel.open", true);
        await network.settle();

        // Assert
        expect(sentPaths(network)).toEqual([]);
        expect(store.get("$.app.panel.open")).toBe(true);
    });

    it("should drop a secret change made while offline", async () => {
        // Arrange
        const network = createFakeNetwork(NAMESPACE, { state: copyJson(STATE) });
        const { store } = open({ transport: network.transport, secret: ["$.app.password.value"] });
        await network.settle();
        network.goOffline();
        await network.settle();

        // Act
        store.set("$.app.password.value", "hunter2");
        network.goOnline();
        await network.settle();

        // Assert
        expect(sentPaths(network)).toEqual([]);
    });
});

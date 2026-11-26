import { afterEach, describe, expect, it } from "vitest";
import { createStore, type Store } from "@punyts/state";
import { copyJson } from "./Apply.js";
import { createStoreBridge } from "./Bridge.js";
import { createSyncClient, type SyncClient } from "./Client.js";
import { openIndexedDbLocalStore } from "./IndexedDbLocalStore.js";
import type { LocalStore } from "./LocalStore.js";
import { createFakeNetwork } from "./__fixtures__/FakeNetwork.js";

const NAMESPACE = "apps.orders";
const STATE = Object.freeze({ app: Object.freeze({ page: 1 }), data: Object.freeze({ total: 10 }) });

let clients: SyncClient[] = [];
let names: string[] = [];

afterEach(async () => {
    clients.forEach((client) => client.stop());
    clients = [];
    await Promise.all(names.map((name) => new Promise((resolve) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = request.onerror = request.onblocked = () => resolve(undefined);
    })));
    names = [];
});

/** Waits for IndexedDB's pending transactions: a readonly transaction after them completes after them */
const settled = async (name: string) => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    const open = indexedDB.open(name);
    const database = await new Promise<IDBDatabase>((resolve) => {
        open.onsuccess = () => resolve(open.result);
    });
    await new Promise((resolve) => {
        const transaction = database.transaction("parts", "readonly");
        transaction.objectStore("parts").count();
        transaction.oncomplete = () => resolve(undefined);
    });
    database.close();
};

const databaseName = () => {
    const name = `punyts.sync.test.${Math.random().toString(36).slice(2)}`;
    names.push(name);
    return name;
};

/** A page load: a new store and client over the same database */
const load = (localStore: LocalStore, transport?: ReturnType<typeof createFakeNetwork>["transport"]) => {
    const store: Store<any> = createStore({});
    const client = createSyncClient({
        namespace: NAMESPACE,
        bridge: createStoreBridge(store),
        localStore,
        backoff: () => 0,
        initial: { state: copyJson<any>(STATE), revision: 0, outbox: [] },
        ...(transport === undefined ? {} : { transport })
    });
    clients.push(client);
    client.start();
    return { store, client };
};

describe("openIndexedDbLocalStore in Chromium", () => {
    it("should read back the parts it kept after the store is opened again", async () => {
        // Arrange
        const name = databaseName();
        const first = await openIndexedDbLocalStore([NAMESPACE], { name });
        first.write(NAMESPACE, "document", { revision: 3 });
        first.write(NAMESPACE, "local", [{ path: "$.app.page", value: 2 }]);
        first.remove(NAMESPACE, "local");
        await settled(name);

        // Act
        const reopened = await openIndexedDbLocalStore([NAMESPACE], { name });

        // Assert
        expect(reopened.read(NAMESPACE, "document")).toEqual({ revision: 3 });
        expect(reopened.read(NAMESPACE, "local")).toBeUndefined();
    });

    it("should read only the namespaces it was opened for", async () => {
        // Arrange
        const name = databaseName();
        const first = await openIndexedDbLocalStore([], { name });
        first.write("apps.other", "document", { revision: 1 });
        await settled(name);

        // Act
        const reopened = await openIndexedDbLocalStore([NAMESPACE], { name });

        // Assert
        expect(reopened.read("apps.other", "document")).toBeUndefined();
    });

    it("should return a copy, so a change to what was read does not change what is kept", async () => {
        // Arrange
        const store = await openIndexedDbLocalStore([NAMESPACE], { name: databaseName() });
        store.write(NAMESPACE, "document", { revision: 1 });

        // Act
        (store.read(NAMESPACE, "document") as { revision: number }).revision = 9;

        // Assert
        expect(store.read(NAMESPACE, "document")).toEqual({ revision: 1 });
    });

    it("should restore the outbox after a reload while offline and send it on reconnect", async () => {
        // Arrange
        const name = databaseName();
        const network = createFakeNetwork(NAMESPACE, { state: copyJson(STATE) });
        const first = load(await openIndexedDbLocalStore([NAMESPACE], { name }), network.transport);
        await network.settle();
        network.goOffline();
        await network.settle();
        first.store.set("$.data.total", 12);
        await settled(name);
        first.client.stop();

        // Act
        const reloaded = load(await openIndexedDbLocalStore([NAMESPACE], { name }), network.transport);
        const mounted = copyJson(reloaded.store.get("$"));
        network.goOnline();
        await network.settle();

        // Assert
        expect(mounted).toEqual({ app: { page: 1 }, data: { total: 12 } });
        expect(network.store.get("$.data.total")).toBe(12);
        expect(reloaded.client.state()).toMatchObject({ revision: 2, outbox: [] });
    });
});

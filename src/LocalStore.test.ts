import { describe, expect, it } from "vitest";
import { createMemoryLocalStore, createWebLocalStore, forgetNamespace, LOCAL_PARTS, type KeyValueStorage } from "./LocalStore.js";

const createStorage = () => {
    const values = new Map<string, string>();
    const storage: KeyValueStorage = {
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
            values.set(key, value);
        },
        removeItem: (key) => {
            values.delete(key);
        }
    };
    return { values, storage };
};

describe("createWebLocalStore", () => {
    it("should keep each part of a namespace under its own key as JSON", () => {
        const { values, storage } = createStorage();
        const local = createWebLocalStore(storage);

        local.write("apps.orders", "confirmed", { state: { data: { total: 1 } }, revision: 3 });
        local.write("apps.orders", "outbox", []);

        expect([...values.keys()]).toEqual(["punyts.sync:apps.orders:confirmed", "punyts.sync:apps.orders:outbox"]);
        expect(local.read("apps.orders", "confirmed")).toEqual({ state: { data: { total: 1 } }, revision: 3 });
    });

    it("should use the prefix it is given", () => {
        const { values, storage } = createStorage();
        const local = createWebLocalStore(storage, "app");

        local.write("orders", "document", { title: "x" });

        expect(values.get("app:orders:document")).toBe('{"title":"x"}');
    });

    it("should read undefined for a part that is not kept or not JSON", () => {
        const { values, storage } = createStorage();
        const local = createWebLocalStore(storage);
        values.set("punyts.sync:apps.orders:outbox", "{not json");

        expect(local.read("apps.orders", "confirmed")).toBeUndefined();
        expect(local.read("apps.orders", "outbox")).toBeUndefined();
    });

    it("should remove a part", () => {
        const { values, storage } = createStorage();
        const local = createWebLocalStore(storage);
        local.write("apps.orders", "outbox", []);

        local.remove("apps.orders", "outbox");

        expect(values.size).toBe(0);
    });

    it("should let a failed write throw and keep the last good value", () => {
        const { storage } = createStorage();
        const local = createWebLocalStore({
            ...storage,
            setItem: (key, value) => {
                if (value.length > 10) {
                    throw new Error("QuotaExceededError");
                }
                storage.setItem(key, value);
            }
        });
        local.write("a", "outbox", [1]);

        expect(() => local.write("a", "outbox", [1, 2, 3, 4, 5, 6])).toThrow("QuotaExceededError");
        expect(local.read("a", "outbox")).toEqual([1]);
    });
});

describe("createMemoryLocalStore", () => {
    it("should keep namespaces apart and return copies", () => {
        const local = createMemoryLocalStore();
        const value = { list: [1] };
        local.write("a", "document", value);
        local.write("b", "document", { list: [2] });

        value.list.push(9);

        expect(local.read("a", "document")).toEqual({ list: [1] });
        expect(local.read("b", "document")).toEqual({ list: [2] });
    });
});

describe("forgetNamespace", () => {
    it("should remove every part of the namespace and nothing else", () => {
        const local = createMemoryLocalStore();
        for (const part of LOCAL_PARTS) local.write("apps.orders", part, 1);
        local.write("apps.other", "confirmed", 2);

        forgetNamespace(local, "apps.orders");

        for (const part of LOCAL_PARTS) expect(local.read("apps.orders", part)).toBeUndefined();
        expect(local.read("apps.other", "confirmed")).toBe(2);
    });
});

import { describe, expect, it } from "vitest";
import { createMemoryNamespaceStorage } from "./NamespaceStorage.js";

describe("createMemoryNamespaceStorage", () => {
    it("should load undefined for a namespace it does not hold", async () => {
        const storage = createMemoryNamespaceStorage();

        expect(await storage.load("apps.orders")).toBeUndefined();
    });

    it("should keep copies per namespace", async () => {
        const storage = createMemoryNamespaceStorage();
        const stored = { state: { data: { total: 1 } }, revision: 1, log: [], applied: [{ id: "x", revision: 1 }] };

        await storage.save("apps.orders", stored);
        stored.state.data.total = 9;
        const loaded = await storage.load("apps.orders");
        loaded!.revision = 5;

        expect(await storage.load("apps.orders")).toEqual({ state: { data: { total: 1 } }, revision: 1, log: [], applied: [{ id: "x", revision: 1 }] });
        expect(await storage.load("apps.other")).toBeUndefined();
    });
});

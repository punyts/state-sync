import { describe, expect, it } from "vitest";
import { createStore } from "@punyts/state";
import { syncSnapshot } from "./Snapshot.js";

describe("syncSnapshot", () => {
    it("should give the state without $.runtime and $.server", () => {
        // Arrange
        const store = createStore({
            app: { view: { page: 1 } },
            data: { total: 12 },
            runtime: { empty: {} },
            server: { key: "secret" }
        });

        // Act
        const snapshot = syncSnapshot(store);

        // Assert
        expect(snapshot).toEqual({ app: { view: { page: 1 } }, data: { total: 12 } });
    });

    it("should leave aliases out", () => {
        // Arrange
        const store = createStore({ data: { orders: { k42: { total: 10 } } }, view: {} });
        store.link("$.view.order", "$.data.orders.k42");

        // Act
        const snapshot = syncSnapshot(store);

        // Assert
        expect(snapshot).toEqual({ data: { orders: { k42: { total: 10 } } }, view: {} });
    });

    it("should be a copy the store does not share", () => {
        // Arrange
        const store = createStore({ data: { list: [1, 2] } });

        // Act
        const snapshot = syncSnapshot(store);
        store.set("$.data.list.0", 9);

        // Assert
        expect(snapshot).toEqual({ data: { list: [1, 2] } });
    });
});

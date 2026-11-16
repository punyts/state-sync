import { describe, expect, it, vi } from "vitest";
import { createStore } from "@punyts/state";
import { copyJson } from "./Apply.js";
import { SYNC_ORIGIN, createStoreBridge } from "./Bridge.js";

const STATE = Object.freeze({
    app: Object.freeze({ page: 1 }),
    data: Object.freeze({ total: 10 }),
    runtime: Object.freeze({ empty: Object.freeze({}) }),
    server: Object.freeze({ key: "k" })
});

describe("createStoreBridge", () => {
    it("should load each branch, remove the others and keep runtime and server", () => {
        const store = createStore<any>(copyJson(STATE));
        const bridge = createStoreBridge(store);

        bridge.load({ data: { total: 12 }, theme: { mode: "dark" } });

        expect(store.get("$")).toEqual({
            data: { total: 12 },
            theme: { mode: "dark" },
            runtime: { empty: {} },
            server: { key: "k" }
        });
    });

    it("should write and delete a path with the sync origin", () => {
        const store = createStore<any>(copyJson(STATE));
        const bridge = createStoreBridge(store);
        const listener = vi.fn();
        store.on("$.data.$all", listener);

        bridge.write("$.data.total", 11);
        bridge.write("$.data.total", undefined);

        expect(listener.mock.calls.map((call) => call[4])).toEqual([SYNC_ORIGIN, SYNC_ORIGIN]);
        expect(store.get("$.data")).toEqual({});
    });

    it("should give the store's own changes without a base, and not its sync writes", async () => {
        const store = createStore<any>(copyJson(STATE));
        const bridge = createStoreBridge(store);
        const onChanges = vi.fn();
        const stop = bridge.subscribe(onChanges);

        bridge.write("$.data.total", 11);
        store.set("$.app.page", 2);
        await Promise.resolve();
        stop();
        store.set("$.app.page", 3);
        await Promise.resolve();

        expect(onChanges).toHaveBeenCalledTimes(1);
        expect(onChanges).toHaveBeenCalledWith([{ id: expect.any(String), path: "$.app.page", op: "set", value: 2 }]);
    });
});

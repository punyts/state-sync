import { describe, expect, it, vi } from "vitest";
import { createStore } from "@punyts/state";
import { applyChange, copyJson } from "./Apply.js";

const STATE = Object.freeze({
    data: Object.freeze({ total: 10, order: Object.freeze({ id: "k42", qty: 1, tags: Object.freeze(["a"]) }) })
});

const setup = () => createStore<any>(copyJson(STATE));

describe("applyChange", () => {
    it("should set a value and replace the keys of an object", () => {
        const store = setup();

        applyChange(store, { path: "$.data.order", op: "set", value: { id: "k43" } });
        applyChange(store, { path: "$.data.note", op: "set", value: "rush" });

        expect(store.get("$.data")).toEqual({ total: 10, order: { id: "k43" }, note: "rush" });
    });

    it("should replace an object with the value", () => {
        const store = setup();

        applyChange(store, { path: "$.data.order", op: "replace", value: { qty: 2 } });

        expect(store.get("$.data.order")).toEqual({ qty: 2 });
    });

    it("should set when a replace meets a value that is not an object", () => {
        const store = setup();

        applyChange(store, { path: "$.data.total", op: "replace", value: { amount: 1 } });
        applyChange(store, { path: "$.data.order", op: "replace", value: 3 });

        expect(store.get("$.data")).toEqual({ total: { amount: 1 }, order: 3 });
    });

    it("should merge the keys of the value into the object", () => {
        const store = setup();

        applyChange(store, { path: "$.data.order", op: "merge", value: { qty: 5, note: "x" } });

        expect(store.get("$.data.order")).toEqual({ id: "k42", qty: 5, tags: ["a"], note: "x" });
    });

    it("should delete the path", () => {
        const store = setup();

        applyChange(store, { path: "$.data.order", op: "delete" });

        expect(store.get("$.data")).toEqual({ total: 10 });
    });

    it("should copy the value so the store does not share it", () => {
        const store = setup();
        const value = { id: "k44", tags: ["b"] };

        applyChange(store, { path: "$.data.order", op: "set", value });
        value.tags.push("c");

        expect(store.get("$.data.order.tags")).toEqual(["b"]);
    });

    it("should create missing parents for a deep set and merge", () => {
        const store = setup();

        applyChange(store, { path: "$.app.children.dialog.open", op: "set", value: true });
        applyChange(store, { path: "$.data.order.qty.extra", op: "merge", value: { a: 1 } });

        expect(store.get("$.app")).toEqual({ children: { dialog: { open: true } } });
        expect(store.get("$.data.order.qty")).toEqual({ extra: { a: 1 } });
    });

    it("should do nothing for a delete below a missing parent", () => {
        const store = setup();

        applyChange(store, { path: "$.app.children.dialog", op: "delete" });

        expect(store.get("$.app")).toBeUndefined();
    });

    it("should pass the origin to the listeners", () => {
        const store = setup();
        const listener = vi.fn();
        store.on("$.data.total", listener);

        applyChange(store, { path: "$.data.total", op: "set", value: 11 }, { origin: "sync" });

        expect(listener).toHaveBeenCalledWith("$.data.total", 11, 10, "update", "sync");
    });
});

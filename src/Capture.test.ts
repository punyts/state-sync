import { afterEach, describe, expect, it, vi } from "vitest";
import { createStore, type Store } from "@punyts/state";
import { captureChanges, type Capture } from "./Capture.js";
import type { Change } from "./Change.js";

const INITIAL = Object.freeze({
    app: Object.freeze({ view: Object.freeze({ page: 1 }) }),
    data: Object.freeze({
        total: 10,
        order: Object.freeze({ id: "k42", qty: 1 }),
        list: Object.freeze([1, 2, 3])
    }),
    runtime: Object.freeze({ empty: Object.freeze({}) }),
    server: Object.freeze({ key: "secret" })
});

const strip = ({ id: _id, ...change }: Change) => change;

let capture: Capture | undefined;

const setup = (base = 3) => {
    const store: Store<any> = createStore(JSON.parse(JSON.stringify(INITIAL)));
    const batches: Change[][] = [];
    let next = 0;
    capture = captureChanges(store, {
        base: () => base,
        onChanges: (changes) => batches.push(changes),
        createId: () => `c${++next}`
    });
    const sent = () => {
        capture!.flush();
        return batches.flat().map(strip);
    };
    return { store, batches, sent };
};

afterEach(() => {
    capture?.stop();
    capture = undefined;
});

describe("captureChanges", () => {
    describe("store actions", () => {
        it("should give a set for an update", () => {
            const { store, sent } = setup();

            store.set("$.data.total", 12);

            expect(sent()).toEqual([{ path: "$.data.total", op: "set", value: 12, base: 3 }]);
        });

        it("should give a set for an insert", () => {
            const { store, sent } = setup();

            store.set("$.data.note", "rush");

            expect(sent()).toEqual([{ path: "$.data.note", op: "set", value: "rush", base: 3 }]);
        });

        it("should give one set for an object written onto an object", () => {
            const { store, sent } = setup();

            store.set("$.data.order", { id: "k43", qty: 2 });

            expect(sent()).toEqual([{ path: "$.data.order", op: "set", value: { id: "k43", qty: 2 }, base: 3 }]);
        });

        it("should give a replace for a replace", () => {
            const { store, sent } = setup();

            store.replace("$.data.order", { id: "k44" });

            expect(sent()).toEqual([{ path: "$.data.order", op: "replace", value: { id: "k44" }, base: 3 }]);
        });

        it("should give a set per key for an apply", () => {
            const { store, sent } = setup();

            store.apply("$.data.order", { qty: 5, note: "x" });

            expect(sent()).toEqual([
                { path: "$.data.order.qty", op: "set", value: 5, base: 3 },
                { path: "$.data.order.note", op: "set", value: "x", base: 3 }
            ]);
        });

        it("should give a delete for a delete", () => {
            const { store, sent } = setup();

            store.delete("$.data.order");

            expect(sent()).toEqual([{ path: "$.data.order", op: "delete", base: 3 }]);
        });

        it("should give a delete for a set of undefined", () => {
            const { store, sent } = setup();

            store.set<number | undefined>("$.data.total", undefined);

            expect(sent()).toEqual([{ path: "$.data.total", op: "delete", base: 3 }]);
        });

        it("should give a set for an assignment through the proxy", () => {
            const { store, sent } = setup();

            store.state.data.total = 20;

            expect(sent()).toEqual([{ path: "$.data.total", op: "set", value: 20, base: 3 }]);
        });

        it("should give a set of the whole array for a write inside an array", () => {
            const { store, sent } = setup();

            store.set("$.data.list.1", 9);

            expect(sent()).toEqual([{ path: "$.data.list", op: "set", value: [1, 9, 3], base: 3 }]);
        });

        it("should give one set of the array after a splice", () => {
            const { store, sent } = setup();

            store.state.data.list.splice(0, 1, 7, 8);

            expect(sent()).toEqual([{ path: "$.data.list", op: "set", value: [7, 8, 2, 3], base: 3 }]);
        });

        it("should give a set of the array after a push and a delete of an element", () => {
            const { store, sent } = setup();

            store.state.data.list.push(4);
            store.delete("$.data.list.0");

            expect(sent()).toEqual([{ path: "$.data.list", op: "set", value: [2, 3, 4], base: 3 }]);
        });

        it("should copy the value when it is written", () => {
            const { store, sent } = setup();

            store.set("$.data.order", { id: "k43", qty: 2 });
            store.set("$.data.other", 1);
            store.state.data.order.qty = 3;

            expect(sent()[0]).toEqual({ path: "$.data.order", op: "set", value: { id: "k43", qty: 2 }, base: 3 });
        });
    });

    describe("skipped events", () => {
        it("should give nothing for a tagged write", () => {
            const { store, sent } = setup();

            store.set("$.data.total", 12, { origin: "sync" });
            store.apply("$.data.order", { qty: 2 }, { origin: "sync" });
            store.delete("$.data.list.0", { origin: "sync" });

            expect(sent()).toEqual([]);
        });

        it("should give nothing for $.runtime and $.server", () => {
            const { store, sent } = setup();

            store.set("$.runtime.empty.x", 1);
            store.set("$.runtime.flag", true);
            store.set("$.server.key", "other");
            store.delete("$.server");

            expect(sent()).toEqual([]);
        });

        it("should give the target path for a write through an alias, and nothing for the alias path", () => {
            const { store, sent } = setup();
            store.link("$.app.view.order", "$.data.order");

            store.set("$.app.view.order.qty", 4);

            expect(sent()).toEqual([{ path: "$.data.order.qty", op: "set", value: 4, base: 3 }]);
        });

        it("should give nothing for a link or a re-point", () => {
            const { store, sent } = setup();
            store.set("$.data.other", { id: "k50" }, { origin: "sync" });

            store.link("$.app.view.order", "$.data.order");
            store.link("$.app.view.order", "$.data.other");

            expect(sent()).toEqual([]);
        });

        it("should give nothing for a write after stop", () => {
            const { store, sent } = setup();
            capture!.stop();

            store.set("$.data.total", 12);

            expect(sent()).toEqual([]);
        });
    });

    describe("batching", () => {
        it("should send the changes of a turn together in a microtask", async () => {
            const { store, batches } = setup();

            store.set("$.data.total", 11);
            store.set("$.app.view.page", 2);
            expect(batches).toEqual([]);
            await Promise.resolve();

            expect(batches).toHaveLength(1);
            expect(batches[0].map(strip)).toEqual([
                { path: "$.data.total", op: "set", value: 11, base: 3 },
                { path: "$.app.view.page", op: "set", value: 2, base: 3 }
            ]);
        });

        it("should keep only the last change of a path", () => {
            const { store, sent } = setup();

            store.set("$.data.total", 11);
            store.set("$.data.total", 12);

            expect(sent()).toEqual([{ path: "$.data.total", op: "set", value: 12, base: 3 }]);
        });

        it("should drop a change below the path of a later change and keep the order of the rest", () => {
            const { store, sent } = setup();

            store.set("$.data.order.qty", 2);
            store.set("$.data.total", 11);
            store.delete("$.data.order");

            expect(sent()).toEqual([
                { path: "$.data.total", op: "set", value: 11, base: 3 },
                { path: "$.data.order", op: "delete", base: 3 }
            ]);
        });

        it("should keep a change below the path of an earlier change", () => {
            const { store, sent } = setup();

            store.set("$.data.order", { id: "k43" });
            store.set("$.data.order.qty", 2);

            expect(sent()).toEqual([
                { path: "$.data.order", op: "set", value: { id: "k43" }, base: 3 },
                { path: "$.data.order.qty", op: "set", value: 2, base: 3 }
            ]);
        });

        it("should read the base and assign ids when the batch is sent", () => {
            let base = 3;
            const store = createStore(JSON.parse(JSON.stringify(INITIAL)));
            const onChanges = vi.fn();
            capture = captureChanges(store, { base: () => base, onChanges, createId: () => "id-1" });

            store.set("$.data.total", 11);
            base = 5;
            capture.flush();

            expect(onChanges).toHaveBeenCalledWith([{ id: "id-1", path: "$.data.total", op: "set", value: 11, base: 5 }]);
        });

        it("should send nothing on a flush with no changes", () => {
            const { batches } = setup();

            capture!.flush();

            expect(batches).toEqual([]);
        });

        it("should drop the waiting changes on stop", async () => {
            const { store, batches } = setup();

            store.set("$.data.total", 11);
            capture!.stop();
            await Promise.resolve();

            expect(batches).toEqual([]);
        });

        it("should make ids with crypto.randomUUID by default", () => {
            const store = createStore(JSON.parse(JSON.stringify(INITIAL)));
            const onChanges = vi.fn();
            capture = captureChanges(store, { base: () => 0, onChanges });

            store.set("$.data.total", 11);
            capture.flush();

            expect(onChanges.mock.calls[0][0][0].id).toMatch(/^[0-9a-f-]{36}$/);
        });
    });
});

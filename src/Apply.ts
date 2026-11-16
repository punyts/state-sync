import type { Store, WriteOptions } from "@punyts/state";
import type { Change, JsonValue } from "./Change.js";

/** A JSON copy of the value; undefined stays undefined */
export const copyJson = <T = JsonValue>(value: unknown): T =>
    value === undefined ? undefined as T : JSON.parse(JSON.stringify(value));

const isComposite = (value: unknown) => typeof value === "object" && value !== null;

/** Sets an empty object at every missing or non-composite ancestor of the path below the top level */
const createParents = (store: Store<any>, path: string, options?: WriteOptions): void => {
    const segments = path.split(".");
    for (let end = 2; end < segments.length; end++) {
        const ancestor = segments.slice(0, end).join(".");
        if (!isComposite(store.get(ancestor))) {
            store.set(ancestor, {}, options);
        }
    }
};

/**
 * Applies a change to a store with the store's own methods: set with set, replace with replace (set when the path or
 * the value is not an object or array), merge with apply (set when nothing is there to merge into) and delete with delete. The value is copied first, so the
 * store never shares an object with the change. A set, replace or merge below a missing parent creates the missing
 * parents as empty objects, so a sparse state (only the articulation of $.app a user changed) takes deep changes; a delete
 * below a missing parent does nothing.
 * @param store
 * @param change
 * @param options - the write options, such as the origin that keeps capture from sending the change back
 */
export const applyChange = (
    store: Store<any>,
    change: Pick<Change, "path" | "op" | "value">,
    options?: WriteOptions
): void => {
    const value = copyJson<any>(change.value);
    if (change.op !== "delete") {
        createParents(store, change.path, options);
    }
    else if (change.path.split(".").length > 2 && !isComposite(store.get(change.path.slice(0, change.path.lastIndexOf("."))))) {
        return;
    }
    switch (change.op) {
        case "set":
            store.set(change.path, value, options);
            return;
        case "replace":
            if (isComposite(value) && isComposite(store.get(change.path))) {
                store.replace(change.path, value, options);
            }
            else {
                store.set(change.path, value, options);
            }
            return;
        case "merge":
            if (isComposite(store.get(change.path))) {
                store.apply(change.path, value, options);
            }
            else {
                store.set(change.path, value, options);
            }
            return;
        case "delete":
            store.delete(change.path, options);
            return;
    }
};

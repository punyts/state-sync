import type { Store, WriteOptions } from "@punyts/state";
import type { Change, JsonValue } from "./Change.js";

/** A JSON copy of the value; undefined stays undefined */
export const copyJson = <T = JsonValue>(value: unknown): T =>
    value === undefined ? undefined as T : JSON.parse(JSON.stringify(value));

const isComposite = (value: unknown) => typeof value === "object" && value !== null;

/**
 * Applies a change to a store with the store's own methods: set with set, replace with replace (set when the path or
 * the value is not an object or array), merge with apply and delete with delete. The value is copied first, so the
 * store never shares an object with the change.
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
            store.apply(change.path, value, options);
            return;
        case "delete":
            store.delete(change.path, options);
            return;
    }
};

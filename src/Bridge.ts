import type { Store } from "@punyts/state";
import { copyJson } from "./Apply.js";
import { captureChanges } from "./Capture.js";
import type { Change, JsonValue } from "./Change.js";

/** The origin sync writes are tagged with, so capture does not send them back */
export const SYNC_ORIGIN = "sync";

/** A change the store made itself; the client gives it the base */
export type LocalChange = Omit<Change, "base">;

/** The state a store syncs: its top-level branches without runtime and server */
export type SyncState = { [key: string]: JsonValue };

/**
 * How the sync client reaches the visible store: directly (createStoreBridge) or over messages to a framed runtime.
 * Writes through the bridge are sync writes and never come back from subscribe.
 */
export interface StoreBridge {
    /** Sets the whole visible state: each top-level branch of state, and removes the others (runtime and server stay) */
    load: (state: SyncState) => void;
    /** Writes the visible value of one path; undefined deletes it */
    write: (path: string, value: JsonValue | undefined) => void;
    /** Gives the store's own changes, in the order they were made; returns the function that stops it */
    subscribe: (onChanges: (changes: LocalChange[]) => void) => () => void;
}

const KEPT_BRANCHES = new Set(["runtime", "server"]);

/**
 * The bridge to a store in the same page. Writes are tagged with SYNC_ORIGIN; the store's own changes come from
 * captureChanges.
 * @param store
 */
export const createStoreBridge = (store: Store<any>): StoreBridge => {
    const options = { origin: SYNC_ORIGIN };
    return {
        load: (state) => {
            for (const key of Object.keys(store.get("$") ?? {})) {
                if (!KEPT_BRANCHES.has(key) && !(key in state)) {
                    store.delete(`$.${key}`, options);
                }
            }
            for (const [key, value] of Object.entries(state)) {
                if (!KEPT_BRANCHES.has(key)) {
                    store.set(`$.${key}`, copyJson<any>(value), options);
                }
            }
        },
        write: (path, value) => {
            if (value === undefined) {
                store.delete(path, options);
            }
            else {
                store.set(path, copyJson<any>(value), options);
            }
        },
        subscribe: (onChanges) => {
            const capture = captureChanges(store, {
                base: () => 0,
                onChanges: (changes) => onChanges(changes.map(({ base: _base, ...change }) => change))
            });
            return capture.stop;
        }
    };
};

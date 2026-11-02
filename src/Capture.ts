import { report } from "@punyts/core";
import type { EventListenerFn, Store } from "@punyts/state";
import type { Change, ChangeOp, JsonValue } from "./Change.js";
import { RUNTIME_PATH, SERVER_PATH, isAtOrBelow, isSyncPath } from "./Paths.js";

export interface CaptureOptions {
    /** The authority revision the store is at, read when a batch is sent */
    base: () => number;
    /** Gets each batch of changes, in the order they were made */
    onChanges: (changes: Change[]) => void;
    /** Makes change ids; globalThis.crypto.randomUUID by default */
    createId?: () => string;
}

export interface Capture {
    /** Sends the changes waiting for the microtask now */
    flush: () => void;
    /** Stops listening; changes waiting are dropped */
    stop: () => void;
}

interface Pending {
    path: string;
    op: ChangeOp;
    value?: JsonValue;
    /** The value is read when the batch is sent (the whole array of an element change) */
    readAtFlush: boolean;
}

const ALL_PATH = "$.$all";

const copyJson = (value: unknown): JsonValue => JSON.parse(JSON.stringify(value));

const parentPath = (path: string) => path.slice(0, path.lastIndexOf("."));

/**
 * Drops each change at or below the path of a later change: the later change holds it. The rest keep their order.
 */
const fold = (pending: Pending[]): Pending[] => {
    const later = new Set<string>();
    const kept: Pending[] = [];
    for (let index = pending.length - 1; index >= 0; index--) {
        const change = pending[index];
        const segments = change.path.split(".");
        let covered = false;
        for (let length = 2; length <= segments.length && !covered; length++) {
            covered = later.has(segments.slice(0, length).join("."));
        }
        later.add(change.path);
        if (!covered) {
            kept.push(change);
        }
    }
    return kept.reverse();
};

/**
 * Turns the store's own writes into changes. Writes made with an origin (a change applied from the authority), the
 * child and relink events, alias paths and the "$.runtime" and "$.server" branches make none. insert and update give a
 * set (a delete when the value is undefined), replace gives a replace and delete a delete. A write inside an array
 * gives a set of the whole array, since splices move every later index. The changes of a turn are sent together in a
 * microtask, folded so a change below a later change's path is left out: setting an object sends one change.
 * @param store
 * @param options
 */
export const captureChanges = (store: Store<any>, options: CaptureOptions): Capture => {
    const createId = options.createId ?? (() => globalThis.crypto.randomUUID());
    let pending: Pending[] = [];
    let scheduled = false;
    let stopped = false;

    const flush = () => {
        scheduled = false;
        if (pending.length === 0) {
            return;
        }
        const batch = fold(pending);
        pending = [];
        const base = options.base();
        const changes = batch.map((entry): Change => {
            const change: Change = { id: createId(), path: entry.path, op: entry.op, base };
            if (entry.readAtFlush) {
                //an array removed by a write that is not captured (one from the authority) is gone at flush
                const value = store.get(entry.path);
                if (value === undefined) {
                    change.op = "delete";
                }
                else {
                    change.value = copyJson(value);
                }
            }
            else if (entry.op !== "delete") {
                change.value = entry.value;
            }
            return change;
        });
        options.onChanges(changes);
    };

    const add = (entry: Pending) => {
        pending.push(entry);
        if (!scheduled) {
            scheduled = true;
            queueMicrotask(() => {
                if (scheduled && !stopped) {
                    flush();
                }
            });
        }
    };

    const listener: EventListenerFn = (path, value, _oldValue, action, origin) => {
        if (origin !== undefined || action.endsWith("-child") || action === "relink") {
            return;
        }
        if (path === "$" || isAtOrBelow(path, RUNTIME_PATH) || isAtOrBelow(path, SERVER_PATH)) {
            return;
        }
        if (store.resolve(path) !== path) {
            return;
        }

        const parent = parentPath(path);
        const inArray = parent !== "$" && Array.isArray(store.get(parent));
        const changed = inArray ? parent : path;
        if (!isSyncPath(changed)) {
            report("state-sync", "Skipping a change at %s: not a sync path", [changed]);
            return;
        }

        if (inArray) {
            add({ path: changed, op: "set", readAtFlush: true });
        }
        else if (action === "delete" || value === undefined) {
            add({ path, op: "delete", readAtFlush: false });
        }
        else if (action === "replace") {
            add({ path, op: "replace", value: copyJson(value), readAtFlush: false });
        }
        else if (action === "insert" || action === "update") {
            add({ path, op: "set", value: copyJson(value), readAtFlush: false });
        }
    };

    store.on(ALL_PATH, listener);

    return {
        flush,
        stop: () => {
            stopped = true;
            pending = [];
            store.off(ALL_PATH, listener);
        }
    };
};

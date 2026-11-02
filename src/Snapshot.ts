import type { Store } from "@punyts/state";
import type { JsonValue } from "./Change.js";

/**
 * The state a store syncs, as JSON: everything except the "$.runtime" and "$.server" branches. Aliases are links, not
 * state, so they are never in it.
 * @param store
 */
export const syncSnapshot = (store: Store<any>): { [key: string]: JsonValue } => {
    const state = JSON.parse(JSON.stringify(store.get("$") ?? {}));
    delete state.runtime;
    delete state.server;
    return state;
};

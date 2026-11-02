import type { JsonValue } from "./Change.js";

/**
 * The parts a namespace is kept in, one key each, so a failed write leaves the last good value of that part:
 * - confirmed: the confirmed state and its revision, together, so they always match
 * - outbox: the changes waiting for the authority
 * - document: the app document, kept by the host
 */
export type LocalPart = "confirmed" | "outbox" | "document";

/** The port the sync client keeps its state in across reloads */
export interface LocalStore {
    /** The part's value, undefined when nothing is kept or it cannot be read */
    read: (namespace: string, part: LocalPart) => JsonValue | undefined;
    /** Keeps the part's value; throws when it cannot (a quota error), leaving the last good value */
    write: (namespace: string, part: LocalPart, value: JsonValue) => void;
    remove: (namespace: string, part: LocalPart) => void;
}

/** The calls of the Web Storage API the adapter uses (localStorage) */
export interface KeyValueStorage {
    getItem: (key: string) => string | null;
    setItem: (key: string, value: string) => void;
    removeItem: (key: string) => void;
}

/**
 * The local store over Web Storage. Each part of a namespace is one key, `<prefix>:<namespace>:<part>`, holding JSON.
 * A value that is not JSON reads as undefined.
 * @param storage - localStorage by default
 * @param prefix - "punyts.sync" by default
 */
export const createWebLocalStore = (
    storage: KeyValueStorage = (globalThis as unknown as { localStorage: KeyValueStorage }).localStorage,
    prefix = "punyts.sync"
): LocalStore => {
    const key = (namespace: string, part: LocalPart) => `${prefix}:${namespace}:${part}`;
    return {
        read: (namespace, part) => {
            const text = storage.getItem(key(namespace, part));
            if (text === null) {
                return undefined;
            }
            try {
                return JSON.parse(text);
            }
            catch {
                return undefined;
            }
        },
        write: (namespace, part, value) => storage.setItem(key(namespace, part), JSON.stringify(value)),
        remove: (namespace, part) => storage.removeItem(key(namespace, part))
    };
};

/** A local store in memory: for tests and hosts with no storage */
export const createMemoryLocalStore = (): LocalStore => {
    const values = new Map<string, string>();
    return createWebLocalStore({
        getItem: (key) => values.get(key) ?? null,
        setItem: (key, value) => {
            values.set(key, value);
        },
        removeItem: (key) => {
            values.delete(key);
        }
    });
};

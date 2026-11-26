import { report } from "@punyts/core";
import type { JsonValue } from "./Change.js";
import { LOCAL_PARTS, type LocalPart, type LocalStore } from "./LocalStore.js";

const CATEGORY = "state-sync.store";
const STORE_NAME = "parts";

/** Options of the IndexedDB local store */
export interface IndexedDbLocalStoreOptions {
    /** The database's name, "punyts.sync" by default */
    name?: string;
    /** The IndexedDB factory, `indexedDB` by default */
    factory?: IDBFactory;
    /** Called when a write or removal could not be kept, with the namespace, the part and the error's name */
    onError?: (namespace: string, part: LocalPart, error: string) => void;
}

const keyOf = (namespace: string, part: LocalPart) => `${namespace}:${part}`;

const requestDone = <T>(request: IDBRequest<T>): Promise<T> =>
    new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

const errorName = (error: unknown): string => (error instanceof Error || error instanceof DOMException ? error.name : String(error));

/**
 * The device's local store in IndexedDB (docs/design/state-definitions-and-instances.md: a composed copy with its
 * datasets outgrows localStorage). The port reads synchronously, so the parts of the namespaces named here are read
 * into memory when the store opens; a namespace not named reads as nothing kept. Writes and removals change memory at
 * once and reach IndexedDB in order after it; a write IndexedDB refuses (a quota error) is reported, goes to
 * `onError`, and memory goes back to the last value kept, unless a later write has replaced it.
 * @param namespaces - the namespaces whose parts are read when the store opens
 */
export const openIndexedDbLocalStore = async (namespaces: readonly string[], options: IndexedDbLocalStoreOptions = {}): Promise<LocalStore> => {
    const factory = options.factory ?? (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB;
    const open = factory.open(options.name ?? "punyts.sync", 1);
    open.onupgradeneeded = () => {
        open.result.createObjectStore(STORE_NAME);
    };
    const database = await requestDone(open);

    /** What memory holds, as JSON text so a read returns a copy */
    const values = new Map<string, string>();
    /** The text IndexedDB last kept for a key, undefined when it holds none */
    const kept = new Map<string, string | undefined>();
    if (namespaces.length > 0) {
        const read = database.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME);
        const keys = namespaces.flatMap((namespace) => LOCAL_PARTS.map((part) => keyOf(namespace, part)));
        const found = await Promise.all(keys.map((key) => requestDone(read.get(key) as IDBRequest<unknown>)));
        keys.forEach((key, index) => {
            const text = found[index];
            if (typeof text === "string") {
                values.set(key, text);
                kept.set(key, text);
            }
        });
    }

    /** The newest change asked of each key, so a failure does not undo a later write */
    const latest = new Map<string, number>();
    let sequence = 0;

    const keep = (namespace: string, part: LocalPart, text: string | undefined) => {
        const key = keyOf(namespace, part);
        const mine = ++sequence;
        latest.set(key, mine);
        if (text === undefined) {
            values.delete(key);
        }
        else {
            values.set(key, text);
        }
        const failed = (error: unknown) => {
            const name = errorName(error);
            report(CATEGORY, "Could not keep the %s of %s: %s", [part, namespace, name]);
            options.onError?.(namespace, part, name);
            if (latest.get(key) !== mine) {
                return;
            }
            const last = kept.get(key);
            if (last === undefined) {
                values.delete(key);
            }
            else {
                values.set(key, last);
            }
        };
        try {
            const transaction = database.transaction(STORE_NAME, "readwrite");
            const parts = transaction.objectStore(STORE_NAME);
            if (text === undefined) {
                parts.delete(key);
            }
            else {
                parts.put(text, key);
            }
            transaction.oncomplete = () => kept.set(key, text);
            transaction.onerror = () => failed(transaction.error);
            transaction.onabort = () => failed(transaction.error);
        }
        catch (error) {
            failed(error);
        }
    };

    return {
        read: (namespace, part) => {
            const text = values.get(keyOf(namespace, part));
            if (text === undefined) {
                return undefined;
            }
            try {
                return JSON.parse(text) as JsonValue;
            }
            catch {
                return undefined;
            }
        },
        write: (namespace, part, value) => keep(namespace, part, JSON.stringify(value)),
        remove: (namespace, part) => keep(namespace, part, undefined)
    };
};

import { copyJson } from "../Apply.js";
import type { JsonValue, RevisedChange } from "../Change.js";

/** A change id the authority applied, with the revision it got */
export interface AppliedChange {
    id: string;
    revision: number;
}

/** What an authority keeps of a namespace */
export interface StoredNamespace {
    state: { [key: string]: JsonValue };
    revision: number;
    /** The most recent changes, oldest first, for catching clients up */
    log: RevisedChange[];
    /** The most recent applied change ids, oldest first, so a resent change is not applied again */
    applied: AppliedChange[];
}

/** The port an authority keeps its namespace in: files, a database, memory */
export interface NamespaceStorage {
    /** The stored namespace, undefined when nothing is stored */
    load: (namespace: string) => Promise<StoredNamespace | undefined>;
    save: (namespace: string, stored: StoredNamespace) => Promise<void>;
}

/** Namespace storage in memory, for tests; it keeps copies */
export const createMemoryNamespaceStorage = (): NamespaceStorage => {
    const namespaces = new Map<string, StoredNamespace>();
    return {
        load: async (namespace) => {
            const stored = namespaces.get(namespace);
            return stored === undefined ? undefined : copyJson<StoredNamespace>(stored);
        },
        save: async (namespace, stored) => {
            namespaces.set(namespace, copyJson<StoredNamespace>(stored));
        }
    };
};

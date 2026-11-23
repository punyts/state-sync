import { copyJson } from "../Apply.js";
import type { Change, JsonValue, RevisedChange } from "../Change.js";
import type { RejectionCode, RequestStatus } from "../Messages.js";

/** A change id the authority applied, with the revision it got */
export interface AppliedChange {
    id: string;
    revision: number;
}

/**
 * A change that waits for a decision (docs/design/statenet-requests.md): sent by someone who may request and not
 * write its path. Its id is the change's
 */
export interface StoredRequest {
    change: Change;
    /** The client id of the hello the change came on */
    clientId: string;
    /** The access subject that sent it */
    by: string;
    /** The permission entries its right rested on: revoking one ends it */
    chain: string[];
    /** When it was made and when it expires, in milliseconds since the epoch */
    at: number;
    until: number;
    status: RequestStatus;
    /** When it was decided, and by whom (withdrawn, expired and revoked ones by nobody) */
    decidedAt?: number;
    decidedBy?: string;
    /** The revision an approved one was applied at */
    revision?: number;
    /** Why a rejected one was: logic or invalid when approving it failed */
    code?: RejectionCode;
    /** The decider's note to a rejection */
    note?: string;
}

/** What an authority keeps of a namespace */
export interface StoredNamespace {
    state: { [key: string]: JsonValue };
    revision: number;
    /** The most recent changes, oldest first, for catching clients up */
    log: RevisedChange[];
    /** The most recent applied change ids, oldest first, so a resent change is not applied again */
    applied: AppliedChange[];
    /**
     * Counts every change to what is stored, those that take no revision too ($.server, requests), so a storage can
     * tell a save sent again from a new one; the revision when it is missing
     */
    serial?: number;
    /** The requests waiting for a decision, and the decided ones kept for their requesters */
    requests?: StoredRequest[];
}

/** The serial of a stored namespace: its revision when it has none */
export const serialOf = (stored: Pick<StoredNamespace, "revision" | "serial">): number => stored.serial ?? stored.revision;

/**
 * Whether a save is one that landed already, or older: a lower revision, or the same revision with a serial no higher.
 * The revision decides first, so a namespace loaded from a storage that keeps no serial is never held back by one
 */
export const isResave = (save: Pick<StoredNamespace, "revision" | "serial">, landed: Pick<StoredNamespace, "revision" | "serial">): boolean =>
    save.revision < landed.revision || (save.revision === landed.revision && serialOf(save) <= serialOf(landed));

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

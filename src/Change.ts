/** A JSON value: what a change carries and what a snapshot holds */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/**
 * What a change does at its path:
 * - set: the path takes the value (created when missing)
 * - replace: the path takes the value and keys the value does not have are removed
 * - merge: the keys of the value are written into the object at the path, other keys stay
 * - delete: the path is removed; a change with this op has no value
 */
export type ChangeOp = "set" | "replace" | "merge" | "delete";

export const CHANGE_OPS: readonly ChangeOp[] = ["set", "replace", "merge", "delete"];

/** One write to a store, as it travels between a client and an authority */
export interface Change {
    /** Unique per change; an ack names the change by it */
    id: string;
    /** The "$."-prefixed path written */
    path: string;
    op: ChangeOp;
    /** The value written; absent for delete */
    value?: JsonValue;
    /** The authority revision the client's state was at when the change was made */
    base: number;
}

/** A change the authority accepted, with the revision it was given (1 or more) */
export interface RevisedChange extends Change {
    revision: number;
}

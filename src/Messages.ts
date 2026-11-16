import type { Change, JsonValue, RevisedChange } from "./Change.js";

/** The version of the sync protocol a client sends in hello: 2 adds the durable watermark and ephemeral changes */
export const PROTOCOL_VERSION = 2;

/** The versions an authority speaks; a version 1 client gets neither durable messages nor a welcome's durable */
export const PROTOCOL_VERSIONS: readonly number[] = [1, 2];

/** A client opens a connection: the namespace it syncs and the revision its state is at (0 for none) */
export interface HelloMessage {
    type: "hello";
    namespace: string;
    revision: number;
    clientId: string;
    protocol: number;
}

/**
 * The authority answers hello with the changes since the client's revision, or a snapshot of the whole namespace when
 * those changes are no longer in its log. Exactly one of changes and snapshot is present.
 */
export interface WelcomeMessage {
    type: "welcome";
    namespace: string;
    revision: number;
    changes?: RevisedChange[];
    snapshot?: JsonValue;
    /** Protocol 2: how far the namespace is durable, so changes up to it are committed */
    durable?: number;
}

/** The authority sends changes other clients or server logic made */
export interface ChangesMessage {
    type: "changes";
    changes: RevisedChange[];
}

/**
 * Protocol 2: everything up to `revision` is durable (stored where it survives the authority), so a listener marks
 * the changes up to it committed; the ones after it are pending
 */
export interface DurableMessage {
    type: "durable";
    revision: number;
}

/** A client sends one change to the authority */
export interface ChangeMessage {
    type: "change";
    change: Change;
}

export type AckResult = "applied" | "adjusted" | "rejected";

/**
 * The authority answers a change:
 * - applied: the change is in at revision
 * - adjusted: server logic changed it; value is what the path holds at revision
 * - rejected: the change is not in; reason says why
 */
export interface AckMessage {
    type: "ack";
    id: string;
    result: AckResult;
    revision?: number;
    value?: JsonValue;
    reason?: string;
}

/** A named event with an optional value, outside the state (a command, a notice) */
export interface EmitMessage {
    type: "emit";
    name: string;
    value?: JsonValue;
}

/** A refusal: the message was malformed, too large, or not allowed */
export interface ErrorMessage {
    type: "error";
    code: string;
    message: string;
}

export type SyncMessage =
    | HelloMessage
    | WelcomeMessage
    | ChangesMessage
    | ChangeMessage
    | AckMessage
    | DurableMessage
    | EmitMessage
    | ErrorMessage;

export type SyncMessageType = SyncMessage["type"];

/**
 * The error code of an authority, or of the server in front of it, that no longer lets this client have the namespace
 * (its access was revoked): the client deletes what it keeps of the namespace and stops for good
 * (`SyncClientOptions.onRevoked`)
 */
export const REVOKED_CODE = "revoked";

/** The error codes parseMessage gives */
export type SyncErrorCode = "invalid-json" | "too-large" | "invalid-message";

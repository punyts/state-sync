import type { Change, JsonValue, RevisedChange } from "./Change.js";

/**
 * The version of the sync protocol a client sends in hello: 2 adds the durable watermark and ephemeral changes, 3
 * requests (docs/design/statenet-requests.md)
 */
export const PROTOCOL_VERSION = 3;

/**
 * The versions an authority speaks; a version 1 client gets neither durable messages nor a welcome's durable, and a
 * client below 3 is sent no request: a change of its that would be one is rejected with `access`
 */
export const PROTOCOL_VERSIONS: readonly number[] = [1, 2, 3];

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
    /** Protocol 3: the requests the client sent, and those it may decide (empty when there are none) */
    requests?: SyncRequest[];
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

export type AckResult = "applied" | "adjusted" | "rejected" | "requested";

/**
 * The authority answers a change:
 * - applied: the change is in at revision
 * - adjusted: server logic changed it; value is what the path holds at revision
 * - rejected: the change is not in; reason says why, and code what kind of refusal it is
 * - requested (protocol 3): the change is not in; it waits as a request of the same id for someone to decide it
 */
export interface AckMessage {
    type: "ack";
    id: string;
    result: AckResult;
    revision?: number;
    value?: JsonValue;
    reason?: string;
    code?: RejectionCode;
}

/**
 * The kind of a rejection, which a client may show without the reason (server logic may put values in a reason):
 * - unsaved: the authority holds too many changes that are not saved yet; the same change may pass later
 * - access: the connection may not write there
 * - invalid: the change cannot be applied (a server-only path, a missing parent)
 * - logic: server logic refused it
 * - unavailable: no authority could take it (the node stopped, the owner moved, the authority closed)
 */
export const REJECTION_CODES = ["unsaved", "access", "invalid", "logic", "unavailable"] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

/** True for a rejection code of the closed list */
export const isRejectionCode = (value: unknown): value is RejectionCode => (REJECTION_CODES as readonly unknown[]).includes(value);

/**
 * Where a request is: pending until someone decides it (approved, rejected), its requester takes it back (withdrawn),
 * its time runs out (expired), or the permission it rests on is revoked (revoked)
 */
export const REQUEST_STATUSES = ["pending", "approved", "rejected", "expired", "withdrawn", "revoked"] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

/** A request as a client is sent it: the change (its id is the request's), who sent it and where it is */
export interface SyncRequest {
    id: string;
    path: string;
    op: Change["op"];
    value?: JsonValue;
    /** The revision the requester's state was at */
    base: number;
    /** The access subject that sent it */
    by: string;
    /** Whether the client's own access sent it */
    mine: boolean;
    /** When it was made and when it expires, in milliseconds since the epoch */
    at: number;
    until: number;
    status: RequestStatus;
    decidedAt?: number;
    /** Why a rejected one was: logic or invalid when approving it failed */
    code?: RejectionCode;
    /** The decider's note to a rejection */
    note?: string;
}

/** Protocol 3: a new request, to its requester and to each client that may decide it */
export interface RequestedMessage {
    type: "requested";
    request: SyncRequest;
}

/** Protocol 3: a request was decided, to its requester and to each client that may decide it */
export interface DecidedMessage {
    type: "decided";
    id: string;
    status: Exclude<RequestStatus, "pending">;
    decidedAt: number;
    code?: RejectionCode;
    note?: string;
}

/** Protocol 3: a client that may decide a request approves it */
export interface ApproveMessage {
    type: "approve";
    id: string;
}

/** Protocol 3: a client that may decide a request rejects it, with a note for the requester */
export interface RejectMessage {
    type: "reject";
    id: string;
    note?: string;
}

/** Protocol 3: the requester takes a pending request back */
export interface WithdrawMessage {
    type: "withdraw";
    id: string;
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
    | ErrorMessage
    | RequestedMessage
    | DecidedMessage
    | ApproveMessage
    | RejectMessage
    | WithdrawMessage;

export type SyncMessageType = SyncMessage["type"];

/**
 * The error code of an authority, or of the server in front of it, that no longer lets this client have the namespace
 * (its access was revoked): the client deletes what it keeps of the namespace and stops for good
 * (`SyncClientOptions.onRevoked`)
 */
export const REVOKED_CODE = "revoked";

/**
 * The error codes an authority answers a decision it does not make with: the request is not there or not pending
 * (no-request), the client may not make it (not-allowed), or the namespace holds too many unsaved changes (unsaved)
 */
export const REQUEST_ERROR_CODES = ["no-request", "not-allowed", "unsaved"] as const;
export type RequestErrorCode = (typeof REQUEST_ERROR_CODES)[number];

/** The error codes parseMessage gives */
export type SyncErrorCode = "invalid-json" | "too-large" | "invalid-message";

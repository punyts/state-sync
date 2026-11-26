import type { Change, JsonValue, RevisedChange } from "./Change.js";

/**
 * The version of the sync protocol a client sends in hello. Protocol 4 is binary after hello
 * (docs/design/statenet-wire-format.md, `createSyncWire`); it has the durable watermark, ephemeral changes and requests
 * (docs/design/statenet-requests.md) of the text protocols it replaced
 */
export const PROTOCOL_VERSION = 4;

/** The versions an authority speaks: a hello of another is `invalid-message` */
export const PROTOCOL_VERSIONS: readonly number[] = [PROTOCOL_VERSION];

/** A client opens a connection: the namespace it syncs and the revision its state is at (0 for none) */
export interface HelloMessage {
    type: "hello";
    namespace: string;
    revision: number;
    clientId: string;
    protocol: number;
    /**
     * The session follows requests only: its welcome carries the requests and no changes, and it gets
     * `requested` and `decided` but no `changes` or `durable`. A relay that serves a namespace's state from its
     * cache opens one to the owner for a browser's requests
     */
    requests?: true;
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
    /** How far the namespace is durable, so changes up to it are committed */
    durable?: number;
    /** The requests the client sent, and those it may decide (empty when there are none) */
    requests?: SyncRequest[];
}

/** The authority sends changes other clients or server logic made */
export interface ChangesMessage {
    type: "changes";
    changes: RevisedChange[];
}

/**
 * Everything up to `revision` is durable (stored where it survives the authority), so a listener marks
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

export type AckResult = "applied" | "adjusted" | "rejected" | "requested" | "passed";

/**
 * The authority answers a change:
 * - applied: the change is in at revision
 * - adjusted: server logic changed it; value is what the path holds at revision
 * - rejected: the change is not in; reason says why, and code what kind of refusal it is
 * - requested: the change is not in; it waits as a request of the same id for someone to decide it
 * - passed: the change was at a secret path; server logic had it, and nothing of it is kept or sent on
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

/** A new request, to its requester and to each client that may decide it */
export interface RequestedMessage {
    type: "requested";
    request: SyncRequest;
}

/** A request was decided, to its requester and to each client that may decide it */
export interface DecidedMessage {
    type: "decided";
    id: string;
    status: Exclude<RequestStatus, "pending">;
    decidedAt: number;
    code?: RejectionCode;
    note?: string;
}

/** A client that may decide a request approves it */
export interface ApproveMessage {
    type: "approve";
    id: string;
}

/** A client that may decide a request rejects it, with a note for the requester */
export interface RejectMessage {
    type: "reject";
    id: string;
    note?: string;
}

/** The requester takes a pending request back */
export interface WithdrawMessage {
    type: "withdraw";
    id: string;
}

/**
 * The client asks the authority to undo the newest change in the namespace's history, or redo the newest undone one
 * (`AuthorityOptions.history`). The authority writes the result as a server write: every client gets it as a change,
 * and no server logic runs for it
 */
export interface HistoryMessage {
    type: "undo" | "redo";
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
    | WithdrawMessage
    | HistoryMessage;

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

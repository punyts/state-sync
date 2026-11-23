import { isReported, report } from "@punyts/core";
import { createStore, type Store } from "@punyts/state";
import { applyChange, copyJson } from "../Apply.js";
import type { Change, JsonValue, RevisedChange } from "../Change.js";
import { PROTOCOL_VERSION, type AckMessage, type HelloMessage, type RequestErrorCode, type RequestStatus, type SyncMessage, type SyncRequest } from "../Messages.js";
import { SERVER_PATH, isAtOrBelow, isSyncPath } from "../Paths.js";
import { syncSnapshot } from "../Snapshot.js";
import { DEFAULT_SYNC_LIMITS, parseMessage, type SyncLimits } from "../Validate.js";
import { serialOf, type AppliedChange, type NamespaceStorage, type StoredNamespace, type StoredRequest } from "./NamespaceStorage.js";
import { mayTouch, pathSteps, patternCovers, type PathPattern } from "@punyts/state";
import { checkAccess, grantPattern, type Access, type AccessAllowed, type GrantContext } from "./Grants.js";
import { decryptServerBranch, encryptServerBranch } from "./ServerCrypto.js";

/** The error codes an authority sends besides those of parseMessage (which also refuses another protocol version) */
export type AuthorityErrorCode = "wrong-namespace" | "no-hello";

/** One client connection, as the caller's WebSocket server gives it */
export interface AuthorityConnection {
    send: (text: string) => void;
    close: () => void;
}

/** What the caller passes the connection's events to */
export interface AuthoritySession {
    /** A message from the client, as text */
    receive: (text: string) => void;
    /** The connection closed */
    close: () => void;
}

export interface AuthorityOptions {
    namespace: string;
    storage: NamespaceStorage;
    /** The state at revision 0 when the storage holds nothing; empty by default */
    initial?: { [key: string]: JsonValue };
    /** The most recent changes kept for catching clients up; 1000 by default */
    logLength?: number;
    /** The most recent applied change ids remembered; 10000 by default, never fewer than the log */
    appliedLength?: number;
    limits?: Partial<SyncLimits>;
    /**
     * The 32-byte key $.server is encrypted with at rest (AES-256-GCM, a fresh nonce per value), from configuration;
     * never stored or logged. Without it the authority keeps no $.server: a server write there throws, and a stored or
     * initial state with one is refused
     */
    serverKey?: Uint8Array;
    /**
     * Accepts client changes and server writes below a parent that does not exist and creates the missing parents as
     * empty objects; such a change is rejected (a write throws) by default. For sparse states, such as the articulation of
     * $.app only where a user changed it
     */
    createParents?: boolean;
    /**
     * Ephemeral paths ("$."-prefixed, "*" matching one segment), such as a pointer or presence: a change at or below one
     * is applied and pushed like any other, marked ephemeral, but never saved, and never holds up the durable watermark
     */
    ephemeral?: readonly string[];
    /**
     * The most changes held that are not saved yet; 10000 by default. While a save does not land (a node with no link to
     * its aggregate), changes are held; past this many a client change is rejected and a server write throws, ephemeral
     * changes excepted, until a save lands. A refusal tries a failed save again
     */
    maxUnsaved?: number;
    /**
     * Checks every client change against its connection's access (`connect`) at the owner node: the owner of `address`
     * writes freely, anyone else needs a write grant that covers the path, checked at each change, so a revoked grant
     * stops working at once. Without it the caller decides who connects
     */
    access?: { address: string; context: () => GrantContext };
    /**
     * Requests (docs/design/statenet-requests.md), with `access`: a change from a protocol 3 session that may request
     * and not write its path waits as a request until the owner, or someone who may read and write the path, decides it
     */
    requests?: RequestOptions;
}

export interface RequestOptions {
    /** How long a request waits for a decision; 7 days by default, never past the grant that allowed it */
    lifeMs?: number;
    /** How long a decided request is kept, so its requester learns the decision; 30 days by default */
    keepMs?: number;
    /** The most pending requests of one requester; 50 by default */
    perRequester?: number;
    /** The most pending requests of the namespace; 1000 by default */
    max?: number;
    /** How often expiry and revocation are checked while the authority runs; a minute by default */
    sweepMs?: number;
    /** The clock, in milliseconds since the epoch; Date.now by default */
    now?: () => number;
}

/** A decision on a request: by someone who may decide it (approve, reject), or by its requester (withdraw) */
export interface RequestDecision {
    id: string;
    action: "approve" | "reject" | "withdraw";
    /** A rejection's note for the requester */
    note?: string;
}

/** What a decision came to: the request's status after it, or why it was not made */
export type DecisionOutcome =
    | { ok: true; status: Exclude<RequestStatus, "pending"> }
    | { ok: false; code: RequestErrorCode; reason: string };

/** What a change handler gets */
export interface ChangeContext {
    /** The client's change, as adjusted by the handlers before this one */
    change: Change;
    /** The client id of the hello on the change's connection */
    clientId: string;
    /** A copy of the value at a path of the current state, $.server included */
    get: (path: string) => JsonValue | undefined;
    /** One of the changes since the change's base is at, above or below its path, or the base is older than the log */
    stale: boolean;
    /** The logged changes after the change's base, oldest first */
    since: RevisedChange[];
    /** An approved request: who asked and when, and who approved it */
    request?: { by: string; at: number; approvedBy: string };
}

/** A handler's answer; undefined applies the change */
export type ChangeVerdict =
    | { result: "apply" }
    | { result: "adjust"; value: JsonValue }
    | { result: "reject"; reason: string }
    | undefined;

/** Server logic for client changes; synchronous, so changes stay in arrival order */
export type ChangeHandler = (context: ChangeContext) => ChangeVerdict;

/** Server logic that runs after a client change was committed and acknowledged */
export type AppliedHandler = (change: RevisedChange, clientId: string) => void;

/** Server logic for a client's emit */
export type EmitHandler = (name: string, value: JsonValue | undefined, clientId: string) => void;

/** A write made by server logic */
export type ServerWrite = Pick<Change, "path" | "op" | "value">;

export interface Authority {
    readonly namespace: string;
    /** Takes a client connection; the caller passes its messages and its close to the session */
    connect: (connection: AuthorityConnection, access?: Access) => AuthoritySession;
    /**
     * A change as a session's would be handled, for a caller that orders changes itself (an owner node), answered at
     * once. `protocol` is the sender's (3 by default): below 3 a change that would be a request is rejected
     */
    submit: (change: Change, from: { clientId: string; access?: Access; protocol?: number }) => Omit<AckMessage, "type">;
    /** Decides a request as `access` (the owner, someone who may read and write its path, or its requester) */
    decide: (decision: RequestDecision, access?: Access) => DecisionOutcome;
    /** Copies of the requests: pending, and decided ones still kept */
    requests: () => StoredRequest[];
    /**
     * Registers server logic for client changes at, below or above the paths a pattern matches ("*" matches one
     * segment); returns the function that removes it
     */
    onChange: (pattern: string, handler: ChangeHandler) => () => void;
    /**
     * Registers server logic that runs after a client change was committed and acknowledged, with the change as
     * applied; it may make server writes. Returns the function that removes it
     */
    onApplied: (handler: AppliedHandler) => () => void;
    /** Registers server logic for client emits; returns the function that removes it */
    onEmit: (handler: EmitHandler) => () => void;
    /**
     * Registers a listener for every change the authority commits, a client's or a server write, in the batches it
     * pushes them in (a relay that serves the namespace onward); returns the function that removes it
     */
    onChanges: (listener: (changes: readonly RevisedChange[]) => void) => () => void;
    /** The changes after a revision, from the log; undefined when the log no longer reaches back to it */
    changesSince: (revision: number) => RevisedChange[] | undefined;
    /**
     * A server write: applied at once and pushed to every client with the next revision, which it returns. A write at or
     * below $.server is applied and saved only: it takes no revision and never reaches a client. Throws for a path that
     * is not a sync path or whose parent does not exist (unless createParents), and for a write to be saved while
     * `maxUnsaved` changes are held.
     */
    write: (write: ServerWrite) => number | undefined;
    /**
     * Server writes applied in order, as one push: the writes outside $.server reach every client in a single changes
     * message. Every path is checked first, so a write that is not a sync path, or one at or below $.server without a
     * serverKey, throws before anything is written, as it does while `maxUnsaved` changes are held. Returns the revision of each write (undefined under $.server)
     */
    writeAll: (writes: readonly ServerWrite[]) => (number | undefined)[];
    /** A copy of the value at a path of the current state, $.server included; undefined when there is none */
    get: (path: string) => JsonValue | undefined;
    /** Sends a named event to every welcomed client */
    emit: (name: string, value?: JsonValue) => void;
    revision: () => number;
    /** How far the namespace is durable: every change up to this revision is saved, or ephemeral */
    durable: () => number;
    /** Resolves once the namespace is durable up to a revision, the current one by default */
    whenDurable: (revision?: number) => Promise<void>;
    /** Registers a listener for each advance of the durable watermark; returns the function that removes it */
    onDurable: (listener: (revision: number) => void) => () => void;
    /** Registers a listener for the authority's close (a relay serving it onward ends its subscriptions); returns the function that removes it */
    onClose: (listener: () => void) => () => void;
    /** A copy of the whole state, $.server included */
    state: () => { [key: string]: JsonValue };
    /** Resolves when every pending save is done */
    flush: () => Promise<void>;
    /** Closes every connection */
    close: () => void;
}

interface Session {
    connection: AuthorityConnection;
    /** Answered with welcome; only welcomed sessions get changes */
    welcomed: boolean;
    clientId: string;
    /** The protocol of its hello: 2 gets the durable watermark */
    protocol: number;
    /** Its hello asked for requests only: no changes and no watermark */
    requestsOnly?: boolean;
    /** Who the connection is and the grant it presents, for `AuthorityOptions.access` */
    access?: Access;
    /** Takes the session's acks in place of its connection (`submit`) */
    answer?: (ack: Omit<AckMessage, "type">) => void;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A path pattern of an authority's options or handlers (`$`, `$.presence.*`), read by @punyts/state's matcher */
const patternOf = (source: string): PathPattern => {
    const pattern = grantPattern(source);
    if (pattern === undefined) {
        throw new Error(`${source} is not a path pattern`);
    }
    return pattern;
};

interface RegisteredHandler {
    pattern: PathPattern;
    handler: ChangeHandler;
}

/** The parent of a "$."-prefixed path; "$" for a top-level path */
const parentOf = (path: string) => path.slice(0, path.lastIndexOf("."));

const isComposite = (value: unknown) => typeof value === "object" && value !== null;

/** The category of the authority's reports: namespaces, revisions, paths, ids and counts, never values */
const CATEGORY = "state-sync.authority";

/** Milliseconds since a start, rounded to a tenth */
const elapsed = (start: number) => Math.round((performance.now() - start) * 10) / 10;

/** The name of a thrown error: its message may hold values, so it is never reported */
const errorName = (error: unknown) => (error instanceof Error ? error.name : typeof error);

/** The key of $.server in the state */
const SERVER_KEY = SERVER_PATH.slice(2);

/** The $.server value as the object of named values it must be, encrypted one by one */
const serverBranch = (value: JsonValue | undefined, namespace: string): { [name: string]: JsonValue } => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${SERVER_PATH} of ${namespace} must be an object of named values`);
    }
    return value;
};

/**
 * The authority of a namespace: it numbers each change it accepts with the next revision, acks it, pushes it to the
 * other clients and catches reconnecting clients up from its log or with a snapshot. Change handlers (server logic) can
 * apply, adjust or reject a change; without them a change is applied in arrival order, stale or not. $.server never
 * leaves the authority.
 * @param options
 */
export const createAuthority = async (options: AuthorityOptions): Promise<Authority> => {
    const { namespace, storage } = options;
    const logLength = Math.max(0, options.logLength ?? 1000);
    const createParents = options.createParents === true;
    const appliedLength = Math.max(logLength, options.appliedLength ?? 10_000);
    const limits: SyncLimits = { ...DEFAULT_SYNC_LIMITS, ...options.limits };
    const maxUnsaved = Math.max(1, options.maxUnsaved ?? 10_000);

    const { serverKey } = options;
    const loadStart = performance.now();
    const stored = await storage.load(namespace);
    const state = copyJson<{ [key: string]: JsonValue }>(stored?.state ?? options.initial ?? {});
    if (state[SERVER_KEY] !== undefined) {
        if (serverKey === undefined) {
            throw new Error(`The state of ${namespace} has ${SERVER_PATH}, but the authority has no serverKey`);
        }
        if (stored !== undefined) {
            state[SERVER_KEY] = decryptServerBranch(serverBranch(state[SERVER_KEY], namespace), serverKey, namespace);
        }
        else {
            serverBranch(state[SERVER_KEY], namespace);
        }
    }
    const store: Store<any> = createStore(state);
    let revision = stored?.revision ?? 0;
    const log: RevisedChange[] = (stored?.log ?? []).slice(-logLength);
    //insertion order is the order the ids were applied in
    const applied = new Map<string, number>((stored?.applied ?? []).map(({ id, revision }) => [id, revision]));
    const requests = new Map<string, StoredRequest>((stored?.requests ?? []).map((request) => [request.change.id, request]));
    //counts every change to what is saved, so a storage tells a save sent again from a new one
    let serial = stored === undefined ? 0 : serialOf(stored);
    const requestOptions = options.requests ?? {};
    const lifeMs = requestOptions.lifeMs ?? 7 * DAY_MS;
    const keepMs = requestOptions.keepMs ?? 30 * DAY_MS;
    const perRequester = requestOptions.perRequester ?? 50;
    const maxRequests = requestOptions.max ?? 1000;
    const now = requestOptions.now ?? Date.now;
    report(CATEGORY, "Loaded %s at revision %s from %s in %s ms, %s changes logged", [namespace, revision, stored === undefined ? "the initial state" : "storage", elapsed(loadStart), log.length]);

    const sessions = new Set<Session>();
    const handlers: RegisteredHandler[] = [];
    const emitHandlers = new Set<EmitHandler>();
    const appliedHandlers = new Set<AppliedHandler>();
    const changeListeners = new Set<(changes: readonly RevisedChange[]) => void>();

    let dirty = false;
    let saving: Promise<void> = Promise.resolve();
    let saveScheduled = false;
    let saveRunning = false;
    /** The changes to be saved that no landed save holds yet, and whether writes are refused for them */
    let unsaved = 0;
    let refusing = false;
    const ephemeral = (options.ephemeral ?? []).map(patternOf);
    const isEphemeral = (path: string) => ephemeral.some((pattern) => patternCovers(pattern, path));
    //everything up to it is saved or ephemeral; a loaded namespace is durable at the revision it was stored at
    let durableRevision = revision;
    const durableListeners = new Set<(revision: number) => void>();
    const closeListeners = new Set<() => void>();
    const durableWaiters: { revision: number; resolve: () => void }[] = [];

    /** Moves the watermark forward, tells the protocol 2 sessions and resolves the waits it passes */
    const markDurable = (to: number) => {
        if (to <= durableRevision) {
            return;
        }
        durableRevision = to;
        for (const session of sessions) {
            if (session.welcomed && session.protocol >= 2 && session.requestsOnly !== true) {
                send(session, { type: "durable", revision: to });
            }
        }
        for (const listener of durableListeners) {
            listener(to);
        }
        for (let index = durableWaiters.length - 1; index >= 0; index--) {
            const waiter = durableWaiters[index] as (typeof durableWaiters)[number];
            if (waiter.revision <= to) {
                durableWaiters.splice(index, 1);
                waiter.resolve();
            }
        }
    };

    /** Removes the values at the paths an ephemeral pattern matches from a copy of the state */
    const stripEphemeral = (state: { [key: string]: JsonValue }) => {
        const strip = (node: JsonValue | undefined, segments: PathPattern["steps"]): void => {
            if (node === null || typeof node !== "object" || Array.isArray(node) || segments.length === 0) {
                return;
            }
            const [first, ...rest] = segments as [PathPattern["steps"][number], ...PathPattern["steps"]];
            for (const key of first.kind === "literal" ? [first.text] : Object.keys(node)) {
                if (rest.length === 0) {
                    delete node[key];
                }
                else {
                    strip(node[key], rest);
                }
            }
        };
        for (const pattern of ephemeral) {
            strip(state, pattern.steps);
        }
    };

    const storedNamespace = (): StoredNamespace => {
        const state = copyJson<{ [key: string]: JsonValue }>(store.get("$"));
        if (state[SERVER_KEY] !== undefined && serverKey !== undefined) {
            //$.server is only ever saved encrypted
            state[SERVER_KEY] = encryptServerBranch(serverBranch(state[SERVER_KEY], namespace), serverKey, namespace);
        }
        stripEphemeral(state);
        return {
            state,
            revision,
            log: copyJson<RevisedChange[]>(log.filter((logged) => logged.ephemeral !== true)),
            applied: [...applied].map(([id, revision]): AppliedChange => ({ id, revision })),
            serial,
            ...(requests.size === 0 ? {} : { requests: copyJson<StoredRequest[]>([...requests.values()]) })
        };
    };

    const save = async () => {
        if (!dirty) {
            return;
        }
        dirty = false;
        saveRunning = true;
        const taking = unsaved;
        const stored = storedNamespace();
        const saveStart = performance.now();
        try {
            await storage.save(namespace, stored);
            report(CATEGORY, "Saved %s at revision %s in %s ms", [namespace, stored.revision, elapsed(saveStart)]);
            unsaved -= taking;
            if (refusing && unsaved < maxUnsaved) {
                refusing = false;
                report(CATEGORY, "Accepting writes to %s again: %s changes are not saved yet", [namespace, unsaved]);
            }
            //nothing durable changed since this save took its copy: everything after it is ephemeral
            markDurable(dirty ? stored.revision : revision);
        }
        catch (error) {
            //tried again with the next change, or with the next refusal
            dirty = true;
            report(CATEGORY, "Could not save namespace %s at revision %s in %s ms: %s", [namespace, stored.revision, elapsed(saveStart), errorName(error)]);
        }
        finally {
            saveRunning = false;
        }
    };

    /** A change to be saved: counted, and saved after the save that runs */
    const scheduleSave = () => {
        dirty = true;
        unsaved++;
        serial++;
        queueSave();
    };

    /**
     * Whether a change to be saved must be refused because `maxUnsaved` changes are held. A refused change starts no
     * save, so a refusal tries a failed save again, unless one is running (a save held until the link is back)
     */
    const holdsTooMany = (): boolean => {
        if (unsaved < maxUnsaved) {
            return false;
        }
        if (!refusing) {
            refusing = true;
            report(CATEGORY, "Refusing writes to %s: %s changes are not saved yet", [namespace, unsaved]);
        }
        if (dirty && !saveRunning) {
            queueSave();
        }
        return true;
    };

    const queueSave = () => {
        if (saveScheduled) {
            return;
        }
        saveScheduled = true;
        queueMicrotask(() => {
            saveScheduled = false;
            //one save at a time; a save after the one running takes every change made meanwhile
            saving = saving.then(save);
        });
    };

    const send = (session: Session, message: SyncMessage) => {
        try {
            session.connection.send(JSON.stringify(message));
        }
        catch (error) {
            report(CATEGORY, "Could not send a %s message in %s: %s", [message.type, namespace, errorName(error)]);
        }
    };

    const refuse = (session: Session, code: AuthorityErrorCode, message: string, close: boolean) => {
        send(session, { type: "error", code, message });
        if (close) {
            sessions.delete(session);
            session.connection.close();
        }
    };

    const onHello = (session: Session, hello: HelloMessage) => {
        if (hello.namespace !== namespace) {
            report(CATEGORY, "Refused a hello for %s on a connection to %s", [hello.namespace, namespace]);
            refuse(session, "wrong-namespace", `this connection syncs ${namespace}`, true);
            return;
        }
        const missing = revision - hello.revision;
        //a client at 0 has nothing; one ahead of the authority has a state the authority does not know
        const logged = hello.revision > 0 && missing >= 0 && missing <= log.length && missing <= limits.maxChanges;
        const durable = hello.protocol >= 2 ? { durable: durableRevision } : {};
        const changes = log.slice(log.length - missing);
        session.clientId = hello.clientId;
        session.protocol = hello.protocol;
        session.requestsOnly = hello.requests === true;
        sweep();
        const context = options.access?.context();
        const asked = hello.protocol >= 3 ? { requests: [...requests.values()].filter((request) => sees(session, request, context)).map((request) => syncRequest(request, session)) } : {};
        if (session.requestsOnly) {
            send(session, { type: "welcome", namespace, revision, changes: [], ...asked });
            session.welcomed = true;
            report(CATEGORY, "Welcomed client %s to the requests of %s", [hello.clientId, namespace]);
            return;
        }
        send(session, logged
            ? { type: "welcome", namespace, revision, changes: hello.protocol >= 2 ? changes : changes.map(({ ephemeral: _ephemeral, ...change }) => change), ...durable, ...asked }
            : { type: "welcome", namespace, revision, snapshot: syncSnapshot(store), ...durable, ...asked });
        session.welcomed = true;
        report(CATEGORY, "Welcomed client %s to %s at revision %s with %s (protocol %s)", [hello.clientId, namespace, revision, logged ? `${changes.length} changes since ${hello.revision}` : "a snapshot", hello.protocol]);
    };

    const ack = (session: Session, message: Omit<AckMessage, "type">) => {
        if (session.answer !== undefined) {
            session.answer(message);
            return;
        }
        send(session, { type: "ack", ...message });
    };

    /** Whether an access may decide a request at a path: the owner, or someone who may read (not cut) and write it */
    const mayDecide = (access: Access | undefined, path: string, context: GrantContext | undefined): boolean => {
        if (options.access === undefined || context === undefined) {
            return false;
        }
        const need = { address: options.access.address, path };
        const read = checkAccess(access, { ...need, right: "read" }, context);
        return read.ok && read.cut === undefined && checkAccess(access, { ...need, right: "write" }, context).ok;
    };

    const isMine = (session: Session, request: StoredRequest) => session.access !== undefined && session.access.subject === request.by;

    /** Whether a session is told of a request: a protocol 3 session of its requester, or of someone who may decide it while it is pending */
    const sees = (session: Session, request: StoredRequest, context: GrantContext | undefined): boolean =>
        session.protocol >= 3 && (isMine(session, request) || (request.status === "pending" && mayDecide(session.access, request.change.path, context)));

    /** A request as a session is sent it */
    const syncRequest = (request: StoredRequest, session: Session): SyncRequest => {
        const { id, path, op, value, base } = request.change;
        return {
            id, path, op, ...(value === undefined ? {} : { value: copyJson(value) }), base,
            by: request.by, mine: isMine(session, request), at: request.at, until: request.until, status: request.status,
            ...(request.decidedAt === undefined ? {} : { decidedAt: request.decidedAt }),
            ...(request.code === undefined ? {} : { code: request.code }),
            ...(request.note === undefined ? {} : { note: request.note })
        };
    };

    /** Ends a pending request with a status, saves it and tells every session that sees it */
    const endRequest = (request: StoredRequest, status: Exclude<RequestStatus, "pending">, decided: Pick<StoredRequest, "decidedBy" | "code" | "note" | "revision"> = {}): DecisionOutcome => {
        const context = options.access?.context();
        //told to those who saw it pending: a decider who could decide it then
        const told = [...sessions].filter((session) => session.welcomed && sees(session, request, context));
        Object.assign(request, { status, decidedAt: now() }, decided);
        scheduleSave();
        report(CATEGORY, "Request %s in %s ended %s", [request.change.id, namespace, status]);
        for (const session of told) {
            send(session, {
                type: "decided", id: request.change.id, status, decidedAt: request.decidedAt as number,
                ...(request.code === undefined ? {} : { code: request.code }),
                ...(request.note === undefined ? {} : { note: request.note })
            });
        }
        return { ok: true, status };
    };

    /**
     * Ends the pending requests whose time ran out or whose permission was revoked, and drops the decided ones kept
     * long enough
     */
    const sweep = () => {
        if (requests.size === 0) {
            return;
        }
        const at = now();
        const context = options.access?.context();
        for (const request of [...requests.values()]) {
            if (request.status === "pending") {
                if (request.chain.some((entry) => context?.revoked?.(entry) === true)) {
                    endRequest(request, "revoked");
                }
                else if (request.until <= at) {
                    endRequest(request, "expired");
                }
            }
            else if ((request.decidedAt ?? request.at) + keepMs <= at) {
                requests.delete(request.change.id);
                scheduleSave();
            }
        }
    };

    /** Keeps a change from someone who may only request it as a pending request, and tells who sees it */
    const makeRequest = (session: Session, received: Change, allowed: AccessAllowed) => {
        const by = (session.access as Access).subject;
        const pending = [...requests.values()].filter((request) => request.status === "pending");
        if (pending.length >= maxRequests || pending.filter((request) => request.by === by).length >= perRequester) {
            rejected(session, received, "too many requests");
            ack(session, { id: received.id, result: "rejected", reason: `${namespace} holds too many requests`, code: "unsaved" });
            return;
        }
        const at = now();
        const request: StoredRequest = { change: copyJson<Change>(received), clientId: session.clientId, by, chain: [...allowed.chain], at, until: Math.min(at + (allowed.requestMs ?? lifeMs), allowed.lasts), status: "pending" };
        requests.set(received.id, request);
        scheduleSave();
        if (isReported(CATEGORY)) {
            report(CATEGORY, "Client %s requested a %s at %s in %s", [session.clientId, received.op, received.path, namespace]);
        }
        ack(session, { id: received.id, result: "requested" });
        const context = options.access?.context();
        for (const other of sessions) {
            if (other.welcomed && sees(other, request, context)) {
                send(other, { type: "requested", request: syncRequest(request, other) });
            }
        }
    };

    /** Approves, rejects or withdraws a pending request as an access */
    const decide = (decision: RequestDecision, access: Access | undefined): DecisionOutcome => {
        sweep();
        const request = requests.get(decision.id);
        if (request === undefined || request.status !== "pending") {
            return { ok: false, code: "no-request", reason: `${namespace} has no pending request ${decision.id}` };
        }
        if (decision.action === "withdraw") {
            return access?.subject === request.by
                ? endRequest(request, "withdrawn")
                : { ok: false, code: "not-allowed", reason: "only its requester withdraws a request" };
        }
        const context = options.access?.context();
        if (access === undefined || !mayDecide(access, request.change.path, context)) {
            return { ok: false, code: "not-allowed", reason: `deciding a request at ${request.change.path} needs read and write` };
        }
        if (decision.action === "reject") {
            return endRequest(request, "rejected", { decidedBy: access.subject, ...(decision.note === undefined ? {} : { note: decision.note }) });
        }
        if (!isEphemeral(request.change.path) && holdsTooMany()) {
            return { ok: false, code: "unsaved", reason: `${namespace} holds ${unsaved} changes that are not saved yet` };
        }
        const outcome = runHandlers(request.clientId, request.change, { by: request.by, at: request.at, approvedBy: access.subject });
        if ("reason" in outcome) {
            return endRequest(request, "rejected", { decidedBy: access.subject, code: "logic" });
        }
        const { change } = outcome;
        if (missingParent(change) !== undefined) {
            return endRequest(request, "rejected", { decidedBy: access.subject, code: "invalid" });
        }
        //pushed to every session, the requester's too: the change arrives as any change does
        const revised = commit(change);
        rememberApplied(change.id, revised.revision);
        const ended = endRequest(request, "approved", { decidedBy: access.subject, revision: revised.revision });
        runApplied(revised, request.clientId);
        return ended;
    };

    const rememberApplied = (id: string, at: number) => {
        applied.set(id, at);
        if (applied.size > appliedLength) {
            applied.delete(applied.keys().next().value!);
        }
    };

    const runApplied = (revised: RevisedChange, clientId: string) => {
        for (const handler of [...appliedHandlers]) {
            try {
                handler(copyJson(revised), clientId);
            } catch (error) {
                report(CATEGORY, "Server logic after a change of %s failed: %s", [namespace, errorName(error)]);
            }
        }
    };

    /** Why the change cannot be applied to the store, or undefined when it can */
    const missingParent = (change: Pick<Change, "path" | "op">): string | undefined => {
        const parent = parentOf(change.path);
        return change.op !== "delete" && !createParents && parent !== "$" && !isComposite(store.get(parent))
            ? `${parent} does not exist`
            : undefined;
    };

    /** Applies an accepted change at the next revision, logs it and pushes it to every welcomed session but the writer */
    /** Applies and logs a change; pushes it to the other clients unless `batch` collects it for one push */
    const commit = (change: Change, writer?: Session, batch?: RevisedChange[]): RevisedChange => {
        applyChange(store, change);
        revision++;
        const passing = isEphemeral(change.path);
        const revised: RevisedChange = passing ? { ...copyJson<Change>(change), revision, ephemeral: true } : { ...copyJson<Change>(change), revision };
        log.push(revised);
        if (log.length > logLength) {
            log.splice(0, log.length - logLength);
        }
        //an ephemeral change is never saved, so it writes nothing and never holds up the watermark
        if (!passing) {
            scheduleSave();
        }
        if (batch !== undefined) {
            batch.push(revised);
        } else {
            push([revised], writer);
        }
        return revised;
    };

    const push = (changes: RevisedChange[], writer?: Session) => {
        if (changes.length === 0) {
            return;
        }
        for (const listener of changeListeners) {
            listener(copyJson<RevisedChange[]>(changes));
        }
        for (const other of sessions) {
            if (other !== writer && other.welcomed && other.requestsOnly !== true) {
                send(other, { type: "changes", changes: other.protocol >= 2 ? changes : changes.map(({ ephemeral: _ephemeral, ...change }) => change) });
            }
        }
    };

    /** Checks a server write before anything is written; throws with the reason */
    const checkWrite = (write: ServerWrite) => {
        if (!isSyncPath(write.path)) {
            throw new Error(`${write.path} is not a sync path`);
        }
        if (isAtOrBelow(write.path, SERVER_PATH) && serverKey === undefined) {
            throw new Error(`${SERVER_PATH} needs a serverKey, so it is never stored in plaintext`);
        }
    };

    /** Throws when the writes hold a change to be saved and `maxUnsaved` changes are held; a batch is let in or refused whole */
    const checkHeld = (writes: readonly ServerWrite[]) => {
        const saved = writes.some((write) => isAtOrBelow(write.path, SERVER_PATH) || !isEphemeral(write.path));
        if (saved && holdsTooMany()) {
            throw new Error(`${namespace} holds ${unsaved} changes that are not saved yet`);
        }
    };

    /** One server write; a write outside $.server is committed into `batch` or pushed at once */
    const serverWrite = (write: ServerWrite, batch?: RevisedChange[]): number | undefined => {
        checkWrite(write);
        const missing = missingParent(write);
        if (missing !== undefined) {
            throw new Error(missing);
        }
        if (isAtOrBelow(write.path, SERVER_PATH)) {
            if (write.path === SERVER_PATH && write.op !== "delete") {
                serverBranch(write.value, namespace);
            }
            //server-only: no revision, so clients never see a gap
            applyChange(store, write);
            scheduleSave();
            return undefined;
        }
        const change: Change = write.value === undefined
            ? { id: globalThis.crypto.randomUUID(), path: write.path, op: write.op, base: revision }
            : { id: globalThis.crypto.randomUUID(), path: write.path, op: write.op, value: copyJson(write.value), base: revision };
        const at = commit(change, undefined, batch).revision;
        if (isReported(CATEGORY)) {
            report(CATEGORY, "Server wrote %s %s in %s at revision %s", [change.op, change.path, namespace, at]);
        }
        return at;
    };

    /** Runs the handlers that touch the change in registration order: the change as adjusted, or the first rejection */
    const runHandlers = (clientId: string, received: Change, request?: ChangeContext["request"]): { change: Change; adjusted: boolean } | { reason: string } => {
        let change = received;
        let adjusted = false;
        const since = log.filter((logged) => logged.revision > received.base);
        const stale = received.base < revision - log.length ||
            since.some((logged) => isAtOrBelow(logged.path, received.path) || isAtOrBelow(received.path, logged.path));
        for (const { pattern, handler } of [...handlers]) {
            if (!mayTouch(pattern, pathSteps(received.path))) {
                continue;
            }
            let verdict: ChangeVerdict;
            try {
                verdict = handler({
                    change: copyJson<Change>(change),
                    clientId,
                    get: (path) => copyJson(store.get(path)),
                    stale,
                    since: copyJson<RevisedChange[]>(since),
                    ...(request === undefined ? {} : { request: { ...request } })
                });
            }
            catch (error) {
                report(CATEGORY, "A change handler for %s in %s failed: %s", [pattern, namespace, errorName(error)]);
                return { reason: "server logic failed" };
            }
            if (verdict?.result === "reject") {
                return { reason: verdict.reason };
            }
            if (verdict?.result === "adjust") {
                change = { ...change, op: "set", value: copyJson(verdict.value) };
                adjusted = true;
            }
        }
        return { change, adjusted };
    };

    /** Reports a rejected client change by its path and the kind of refusal; a reason may come from server logic, so it is left out */
    const rejected = (session: Session, received: Change, by: string) => {
        if (isReported(CATEGORY)) {
            report(CATEGORY, "Rejected the change of client %s at %s in %s: %s", [session.clientId, received.path, namespace, by]);
        }
    };

    const onChange = (session: Session, received: Change) => {
        const known = applied.get(received.id);
        if (known !== undefined) {
            if (isReported(CATEGORY)) {
                report(CATEGORY, "Acked change %s again in %s: applied at revision %s", [received.id, namespace, known]);
            }
            ack(session, { id: received.id, result: "applied", revision: known });
            return;
        }
        const asked = requests.get(received.id);
        if (asked !== undefined) {
            //a request sent again: the same answer as the first time, or the decision since
            if (asked.status === "pending") {
                ack(session, { id: received.id, result: "requested" });
            }
            else if (asked.status === "approved" && asked.revision !== undefined) {
                ack(session, { id: received.id, result: "applied", revision: asked.revision });
            }
            else {
                ack(session, { id: received.id, result: "rejected", reason: `the request was ${asked.status}`, code: asked.code ?? "access" });
            }
            return;
        }
        if (isAtOrBelow(received.path, SERVER_PATH)) {
            rejected(session, received, "server-only");
            ack(session, { id: received.id, result: "rejected", reason: `${SERVER_PATH} is server-only`, code: "invalid" });
            return;
        }
        if (!isEphemeral(received.path) && holdsTooMany()) {
            rejected(session, received, "too many unsaved changes");
            ack(session, { id: received.id, result: "rejected", reason: `${namespace} holds ${unsaved} changes that are not saved yet`, code: "unsaved" });
            return;
        }
        if (options.access !== undefined) {
            const context = options.access.context();
            const allowed = checkAccess(session.access, { address: options.access.address, path: received.path, right: "write" }, context);
            //without write, a protocol 3 session that may request the path asks for the change
            const asking = allowed.ok || session.protocol < 3 || session.access === undefined
                ? undefined
                : checkAccess(session.access, { address: options.access.address, path: received.path, right: "request" }, context);
            if (asking?.ok === true) {
                makeRequest(session, received, asking);
                return;
            }
            if (!allowed.ok) {
                rejected(session, received, "no write access");
                ack(session, { id: received.id, result: "rejected", reason: allowed.reason, code: "access" });
                return;
            }
        }
        const outcome = runHandlers(session.clientId, received);
        if ("reason" in outcome) {
            rejected(session, received, "server logic");
            ack(session, { id: received.id, result: "rejected", reason: outcome.reason, code: "logic" });
            return;
        }
        const { change, adjusted } = outcome;
        //checked after the handlers: an adjust turns a delete into a set
        const missing = missingParent(change);
        if (missing !== undefined) {
            rejected(session, received, "missing parent");
            ack(session, { id: received.id, result: "rejected", reason: missing, code: "invalid" });
            return;
        }
        const revised = commit(change, session);
        const at = revised.revision;
        if (isReported(CATEGORY)) {
            report(CATEGORY, "%s the %s of client %s at %s in %s at revision %s", [adjusted ? "Adjusted" : "Applied", change.op, session.clientId, change.path, namespace, at]);
        }
        rememberApplied(change.id, at);
        ack(session, adjusted
            ? { id: change.id, result: "adjusted", revision: at, value: copyJson(change.value) }
            : { id: change.id, result: "applied", revision: at });
        runApplied(revised, session.clientId);
    };

    const onEmit = (session: Session, name: string, value: JsonValue | undefined) => {
        for (const handler of [...emitHandlers]) {
            try {
                handler(name, copyJson(value), session.clientId);
            }
            catch (error) {
                report(CATEGORY, "An emit handler for %s in %s failed: %s", [name, namespace, errorName(error)]);
            }
        }
    };

    const receive = (session: Session, text: string) => {
        if (!sessions.has(session)) {
            return;
        }
        const parsed = parseMessage(text, limits);
        if (!parsed.ok) {
            report(CATEGORY, "Refused a message from client %s of %s: %s", [session.clientId, namespace, parsed.error.code]);
            send(session, parsed.error);
            return;
        }
        const message = parsed.message;
        switch (message.type) {
            case "hello":
                onHello(session, message);
                return;
            case "change":
                if (!session.welcomed) {
                    refuse(session, "no-hello", "send hello first", false);
                    return;
                }
                onChange(session, message.change);
                return;
            case "emit":
                if (!session.welcomed) {
                    refuse(session, "no-hello", "send hello first", false);
                    return;
                }
                onEmit(session, message.name, message.value);
                return;
            case "approve":
            case "reject":
            case "withdraw": {
                if (!session.welcomed) {
                    refuse(session, "no-hello", "send hello first", false);
                    return;
                }
                const outcome = decide({ id: message.id, action: message.type, ...(message.type === "reject" && message.note !== undefined ? { note: message.note } : {}) }, session.access);
                if (!outcome.ok) {
                    report(CATEGORY, "Refused to %s request %s in %s for client %s: %s", [message.type, message.id, namespace, session.clientId, outcome.code]);
                    send(session, { type: "error", code: outcome.code, message: outcome.reason });
                }
                return;
            }
            case "error":
                report(CATEGORY, "A client of %s sent the error %s", [namespace, message.code]);
                return;
            default:
                report(CATEGORY, "Ignoring a %s message from a client of %s", [message.type, namespace]);
        }
    };

    sweep();
    const sweeping = options.access === undefined ? undefined : setInterval(sweep, Math.max(10, requestOptions.sweepMs ?? 60_000));
    (sweeping as { unref?: () => void } | undefined)?.unref?.();

    return {
        namespace,
        submit: (change, from) => {
            const parsed = parseMessage({ type: "change", change }, limits);
            if (!parsed.ok) {
                return { id: change.id, result: "rejected", reason: parsed.error.message, code: "invalid" };
            }
            let answer: Omit<AckMessage, "type"> | undefined;
            const session: Session = {
                connection: { send: () => undefined, close: () => undefined },
                welcomed: true,
                clientId: from.clientId,
                protocol: from.protocol ?? PROTOCOL_VERSION,
                ...(from.access === undefined ? {} : { access: from.access }),
                answer: (given) => {
                    answer = given;
                }
            };
            onChange(session, copyJson<Change>(change));
            return answer ?? { id: change.id, result: "rejected", reason: "the change was not answered", code: "invalid" };
        },
        decide: (decision, access) => decide(decision, access),
        requests: () => copyJson<StoredRequest[]>([...requests.values()]),
        connect: (connection, access) => {
            const session: Session = { connection, welcomed: false, clientId: "", protocol: 1, ...(access === undefined ? {} : { access }) };
            sessions.add(session);
            report(CATEGORY, "A client connected to %s: %s connections", [namespace, sessions.size]);
            return {
                receive: (text) => receive(session, text),
                close: () => {
                    if (sessions.delete(session)) {
                        report(CATEGORY, "Client %s left %s: %s connections", [session.clientId, namespace, sessions.size]);
                    }
                }
            };
        },
        onChange: (pattern, handler) => {
            const registered: RegisteredHandler = { pattern: patternOf(pattern), handler };
            handlers.push(registered);
            return () => {
                const index = handlers.indexOf(registered);
                if (index >= 0) {
                    handlers.splice(index, 1);
                }
            };
        },
        onEmit: (handler) => {
            emitHandlers.add(handler);
            return () => {
                emitHandlers.delete(handler);
            };
        },
        onChanges: (listener) => {
            changeListeners.add(listener);
            return () => {
                changeListeners.delete(listener);
            };
        },
        changesSince: (since) => {
            if (since === revision) {
                return [];
            }
            //the log is complete back to the revision before its first change
            const first = log[0];
            if (since > revision || first === undefined || since < first.revision - 1) {
                return undefined;
            }
            return copyJson<RevisedChange[]>(log.filter((logged) => logged.revision > since));
        },
        onApplied: (handler) => {
            appliedHandlers.add(handler);
            return () => {
                appliedHandlers.delete(handler);
            };
        },
        write: (write) => {
            checkWrite(write);
            checkHeld([write]);
            return serverWrite(write);
        },
        writeAll: (writes) => {
            writes.forEach(checkWrite);
            checkHeld(writes);
            const batch: RevisedChange[] = [];
            try {
                return writes.map((write) => serverWrite(write, batch));
            } finally {
                push(batch);
            }
        },
        get: (path) => {
            const value: unknown = path === "$" ? store.get("$") : store.get(path);
            return value === undefined ? undefined : copyJson<JsonValue>(value as JsonValue);
        },
        emit: (name, value) => {
            for (const session of sessions) {
                if (session.welcomed) {
                    send(session, value === undefined ? { type: "emit", name } : { type: "emit", name, value });
                }
            }
        },
        revision: () => revision,
        durable: () => durableRevision,
        whenDurable: (at = revision) => {
            //a revision no durable change reached is durable already: only ephemeral changes came after the watermark
            if (at <= durableRevision || (!dirty && !saveScheduled && log.filter((logged) => logged.revision > durableRevision && logged.revision <= at).every((logged) => logged.ephemeral === true))) {
                return Promise.resolve();
            }
            return new Promise<void>((resolve) => durableWaiters.push({ revision: at, resolve }));
        },
        onDurable: (listener) => {
            durableListeners.add(listener);
            return () => {
                durableListeners.delete(listener);
            };
        },
        state: () => copyJson(store.get("$")),
        flush: async () => {
            if (saveScheduled) {
                //the scheduled save was queued first, so it has joined the chain when this resolves
                await new Promise<void>((resolve) => queueMicrotask(resolve));
            }
            await saving;
        },
        onClose: (listener) => {
            closeListeners.add(listener);
            return () => {
                closeListeners.delete(listener);
            };
        },
        close: () => {
            if (sweeping !== undefined) {
                clearInterval(sweeping);
            }
            report(CATEGORY, "Closed %s at revision %s with %s connections", [namespace, revision, sessions.size]);
            for (const session of [...sessions]) {
                sessions.delete(session);
                session.connection.close();
            }
            for (const listener of [...closeListeners]) {
                closeListeners.delete(listener);
                listener();
            }
        }
    };
};

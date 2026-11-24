import { CborError, decodeCbor, encodeCbor } from "./Cbor.js";
import type { CborValue } from "./Cbor.js";
import { CHANGE_OPS } from "./Change.js";
import type { Change, RevisedChange } from "./Change.js";
import { REJECTION_CODES, REQUEST_STATUSES } from "./Messages.js";
import type { AckResult, SyncMessage, SyncRequest } from "./Messages.js";
import { DEFAULT_SYNC_LIMITS, parseMessage, validateMessage } from "./Validate.js";
import type { ParseResult, SyncLimits } from "./Validate.js";

/**
 * The sync wire of protocol 4 (docs/design/statenet-wire-format.md, W2): what one connection sends and receives.
 * `hello` and `error` are JSON text, so a client of any protocol can say which it speaks and read why it was refused;
 * every other message is a CBOR array `[code, …fields]` in a fixed order, with no field names:
 * - welcome `[2, namespace, revision, durable | null, requests | null, changes | null, snapshot?]`
 * - changes `[3, [revisedChange, …]]`, durable `[4, revision]`, change `[5, change]`
 * - ack `[6, id, result, revision | null, reason | null, code | null, value?]`
 * - requested `[7, request]`, decided `[8, id, status, decidedAt, code | null, note | null]`
 * - approve `[9, id]`, reject `[10, id, note?]`, withdraw `[11, id]`, emit `[12, name, value?]`
 * - a change `[id, path, op, base, value?]`; a revised one `[revision, id, path, op, base, value?]`, its op plus 4 when
 *   ephemeral; a request `[id, path, op, base, by, mine, at, until, status, decidedAt | null, code | null, note | null,
 *   value?]`. Ops, results, statuses and codes are their index in their closed list.
 *
 * Paths go by number: the first time this side sends a path it goes as `[number, path]` (numbers from 0, in order),
 * then as the number; past `MAX_WIRE_PATHS` a path goes as text. A change or request id that is a lowercase uuid goes as
 * its 16 bytes. Both tables live as long as the connection; a second hello on it keeps them.
 */

/** The most paths one side of a connection numbers; later ones go as text */
export const MAX_WIRE_PATHS = 4096;

const CODE = {
    welcome: 2,
    changes: 3,
    durable: 4,
    change: 5,
    ack: 6,
    requested: 7,
    decided: 8,
    approve: 9,
    reject: 10,
    withdraw: 11,
    emit: 12
} as const;

const ACK_RESULTS: readonly AckResult[] = ["applied", "adjusted", "rejected", "requested"];
const EPHEMERAL = 4;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** One connection's sync wire: write a message to send, read what arrived */
export interface SyncWire {
    /** `hello` and `error` as JSON text, every other message as CBOR bytes */
    write(message: SyncMessage): string | Uint8Array;
    /** A message that arrived; text must be a `hello` or an `error`, bytes any other message */
    read(data: string | Uint8Array): ParseResult;
}

const TYPES = Object.fromEntries(Object.entries(CODE).map(([type, code]) => [code, type])) as Record<number, Exclude<SyncMessage["type"], "hello" | "error">>;

/**
 * The type of a protocol 4 message from its first two bytes, without reading it (an array head of one to seven items,
 * then the code), or undefined for text and for bytes that are no message. A relay uses it to pick out emits and changes
 * without reading the paths a connection's wire numbers
 */
export const wireTypeOf = (data: string | Uint8Array): Exclude<SyncMessage["type"], "hello" | "error"> | undefined => {
    if (typeof data === "string" || data.length < 2) return undefined;
    const head = data[0] as number;
    return head >= 0x81 && head <= 0x87 ? TYPES[data[1] as number] : undefined;
};

/** A refusal to stop reading with; its message is the reason sent back */
class Unreadable extends Error { }

const unreadable = (reason: string): never => {
    throw new Unreadable(reason);
};

const idOut = (id: string): string | Uint8Array => {
    if (!UUID.test(id)) return id;
    const hex = id.replace(/-/g, "");
    const bytes = new Uint8Array(16);
    for (let index = 0; index < 16; index++) bytes[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    return bytes;
};

const idIn = (value: CborValue | undefined, where: string): string => {
    if (typeof value === "string") return value;
    if (!(value instanceof Uint8Array) || value.length !== 16) return unreadable(`${where} must be text or 16 bytes`);
    const hex = Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** An index into a closed list, or a refusal */
const indexIn = <T>(list: readonly T[], value: CborValue | undefined, where: string): T => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value >= list.length) return unreadable(`${where} is not one of ${list.length}`);
    return list[value] as T;
};

const nullable = <T>(value: T | null | undefined): T | undefined => (value === null ? undefined : value);

const arrayOf = (value: CborValue | undefined, where: string, min: number, max: number): CborValue[] => {
    if (!Array.isArray(value) || value.length < min || value.length > max) return unreadable(`${where} must be an array of ${min} to ${max}`);
    return value;
};

/**
 * Creates the wire of one connection. Both sides of a connection make one; each numbers the paths it sends, and reads
 * the numbers the other side sends
 */
export function createSyncWire(limits: Partial<SyncLimits> = {}): SyncWire {
    const bounds: SyncLimits = { ...DEFAULT_SYNC_LIMITS, ...limits };
    // A message nests a value inside at most four levels of its own (welcome, changes, change, value)
    const cbor = { bytes: true, limits: { maxBytes: bounds.maxMessageSize, maxDepth: bounds.maxDepth + 4, maxItems: bounds.maxMessageSize, maxStringBytes: bounds.maxMessageSize } };
    const sent = new Map<string, number>();
    const received: string[] = [];

    const pathOut = (path: string): CborValue => {
        const known = sent.get(path);
        if (known !== undefined) return known;
        if (sent.size >= MAX_WIRE_PATHS) return path;
        const number = sent.size;
        sent.set(path, number);
        return [number, path];
    };

    const pathIn = (value: CborValue | undefined): string => {
        if (typeof value === "string") return value;
        if (typeof value === "number") {
            const known = received[value];
            return known ?? unreadable(`path ${value} was not sent before`);
        }
        const [number, path] = arrayOf(value, "a path", 2, 2);
        if (number !== received.length || typeof path !== "string") return unreadable(`a new path must be numbered ${received.length}`);
        if (received.length >= MAX_WIRE_PATHS) return unreadable(`more than ${MAX_WIRE_PATHS} paths`);
        received.push(path);
        return path;
    };

    const changeOut = (change: Change): CborValue => {
        const fields: CborValue[] = [idOut(change.id), pathOut(change.path), CHANGE_OPS.indexOf(change.op), change.base];
        if (change.value !== undefined) fields.push(change.value);
        return fields;
    };

    const revisedOut = (change: RevisedChange): CborValue => {
        const op = CHANGE_OPS.indexOf(change.op) + (change.ephemeral === true ? EPHEMERAL : 0);
        const fields: CborValue[] = [change.revision, idOut(change.id), pathOut(change.path), op, change.base];
        if (change.value !== undefined) fields.push(change.value);
        return fields;
    };

    const requestOut = (request: SyncRequest): CborValue => {
        const fields: CborValue[] = [
            idOut(request.id), pathOut(request.path), CHANGE_OPS.indexOf(request.op), request.base, request.by, request.mine, request.at, request.until,
            REQUEST_STATUSES.indexOf(request.status), request.decidedAt ?? null, request.code === undefined ? null : REJECTION_CODES.indexOf(request.code), request.note ?? null
        ];
        if (request.value !== undefined) fields.push(request.value);
        return fields;
    };

    const changeIn = (value: CborValue | undefined): Record<string, unknown> => {
        const [id, path, op, base, ...rest] = arrayOf(value, "a change", 4, 5);
        return { id: idIn(id, "a change's id"), path: pathIn(path), op: indexIn(CHANGE_OPS, op, "a change's op"), base, ...(rest.length === 1 && { value: rest[0] }) };
    };

    const revisedIn = (value: CborValue | undefined): Record<string, unknown> => {
        const [revision, id, path, op, base, ...rest] = arrayOf(value, "a change", 5, 6);
        const code = typeof op === "number" ? op : -1;
        const ephemeral = code >= EPHEMERAL;
        return {
            revision,
            id: idIn(id, "a change's id"),
            path: pathIn(path),
            op: indexIn(CHANGE_OPS, ephemeral ? code - EPHEMERAL : op, "a change's op"),
            base,
            ...(rest.length === 1 && { value: rest[0] }),
            ...(ephemeral && { ephemeral: true })
        };
    };

    const requestIn = (value: CborValue | undefined): Record<string, unknown> => {
        const [id, path, op, base, by, mine, at, until, status, decidedAt, code, note, ...rest] = arrayOf(value, "a request", 12, 13);
        return {
            id: idIn(id, "a request's id"),
            path: pathIn(path),
            op: indexIn(CHANGE_OPS, op, "a request's op"),
            ...(rest.length === 1 && { value: rest[0] }),
            base,
            by,
            mine,
            at,
            until,
            status: indexIn(REQUEST_STATUSES, status, "a request's status"),
            ...(decidedAt !== null && { decidedAt }),
            ...(code !== null && { code: indexIn(REJECTION_CODES, code, "a request's code") }),
            ...(note !== null && { note })
        };
    };

    const encode = (message: Exclude<SyncMessage, { type: "hello" | "error" }>): CborValue => {
        switch (message.type) {
            case "welcome": {
                const fields: CborValue[] = [
                    CODE.welcome, message.namespace, message.revision, message.durable ?? null,
                    message.requests === undefined ? null : message.requests.map(requestOut),
                    message.changes === undefined ? null : message.changes.map(revisedOut)
                ];
                if (message.snapshot !== undefined) fields.push(message.snapshot);
                return fields;
            }
            case "changes":
                return [CODE.changes, message.changes.map(revisedOut)];
            case "durable":
                return [CODE.durable, message.revision];
            case "change":
                return [CODE.change, changeOut(message.change)];
            case "ack": {
                const fields: CborValue[] = [
                    CODE.ack, idOut(message.id), ACK_RESULTS.indexOf(message.result), message.revision ?? null, message.reason ?? null,
                    message.code === undefined ? null : REJECTION_CODES.indexOf(message.code)
                ];
                if (message.value !== undefined) fields.push(message.value);
                return fields;
            }
            case "requested":
                return [CODE.requested, requestOut(message.request)];
            case "decided":
                return [CODE.decided, idOut(message.id), REQUEST_STATUSES.indexOf(message.status), message.decidedAt, message.code === undefined ? null : REJECTION_CODES.indexOf(message.code), message.note ?? null];
            case "approve":
                return [CODE.approve, idOut(message.id)];
            case "reject":
                return message.note === undefined ? [CODE.reject, idOut(message.id)] : [CODE.reject, idOut(message.id), message.note];
            case "withdraw":
                return [CODE.withdraw, idOut(message.id)];
            case "emit":
                return message.value === undefined ? [CODE.emit, message.name] : [CODE.emit, message.name, message.value];
        }
    };

    /** The message object an array stands for, for the validator to check as it checks a parsed one */
    const decode = (value: CborValue): Record<string, unknown> => {
        const [code, ...fields] = arrayOf(value, "a message", 1, 7);
        switch (code) {
            case CODE.welcome: {
                const [namespace, revision, durable, requests, changes, ...rest] = arrayOf(fields, "welcome", 5, 6);
                // In the order they were written, so new paths are numbered as the sender numbered them
                const asked = requests === null ? undefined : arrayOf(requests, "welcome's requests", 0, bounds.maxMessageSize).map(requestIn);
                return {
                    type: "welcome", namespace, revision,
                    ...(changes !== null && { changes: arrayOf(changes, "welcome's changes", 0, bounds.maxChanges).map(revisedIn) }),
                    ...(rest.length === 1 && { snapshot: rest[0] }),
                    ...(durable !== null && { durable }),
                    ...(asked !== undefined && { requests: asked })
                };
            }
            case CODE.changes: {
                const [changes] = arrayOf(fields, "changes", 1, 1);
                return { type: "changes", changes: arrayOf(changes, "changes", 0, bounds.maxChanges).map(revisedIn) };
            }
            case CODE.durable: {
                const [revision] = arrayOf(fields, "durable", 1, 1);
                return { type: "durable", revision };
            }
            case CODE.change: {
                const [change] = arrayOf(fields, "change", 1, 1);
                return { type: "change", change: changeIn(change) };
            }
            case CODE.ack: {
                const [id, result, revision, reason, rejection, ...rest] = arrayOf(fields, "ack", 5, 6);
                return {
                    type: "ack", id: idIn(id, "an ack's id"), result: indexIn(ACK_RESULTS, result, "an ack's result"),
                    ...(revision !== null && { revision }),
                    ...(rest.length === 1 && { value: rest[0] }),
                    ...(reason !== null && { reason }),
                    ...(rejection !== null && { code: indexIn(REJECTION_CODES, rejection, "an ack's code") })
                };
            }
            case CODE.requested: {
                const [request] = arrayOf(fields, "requested", 1, 1);
                return { type: "requested", request: requestIn(request) };
            }
            case CODE.decided: {
                const [id, status, decidedAt, rejection, note] = arrayOf(fields, "decided", 5, 5);
                return {
                    type: "decided", id: idIn(id, "decided's id"), status: indexIn(REQUEST_STATUSES, status, "decided's status"), decidedAt,
                    ...(rejection !== null && { code: indexIn(REJECTION_CODES, rejection, "decided's code") }),
                    ...(note !== null && { note })
                };
            }
            case CODE.approve:
            case CODE.withdraw: {
                const [id] = arrayOf(fields, code === CODE.approve ? "approve" : "withdraw", 1, 1);
                return { type: code === CODE.approve ? "approve" : "withdraw", id: idIn(id, "the request's id") };
            }
            case CODE.reject: {
                const [id, ...rest] = arrayOf(fields, "reject", 1, 2);
                return { type: "reject", id: idIn(id, "reject's id"), ...(rest.length === 1 && { note: rest[0] }) };
            }
            case CODE.emit: {
                const [name, ...rest] = arrayOf(fields, "emit", 1, 2);
                return { type: "emit", name, ...(rest.length === 1 && { value: rest[0] }) };
            }
            default:
                return unreadable(typeof code === "number" ? `unknown message code ${code}` : "a message's code must be a number");
        }
    };

    const refuse = (code: "too-large" | "invalid-message", message: string): ParseResult => ({ ok: false, error: { type: "error", code, message } });

    return {
        write: (message) => (message.type === "hello" || message.type === "error" ? JSON.stringify(message) : encodeCbor(encode(message), { bytes: true, maxDepth: cbor.limits.maxDepth })),
        read: (data) => {
            if (typeof data === "string") {
                const parsed = parseMessage(data, bounds);
                if (parsed.ok && parsed.message.type !== "hello" && parsed.message.type !== "error") {
                    return refuse("invalid-message", `a ${parsed.message.type} must be binary`);
                }
                return parsed;
            }
            if (data.length > bounds.maxMessageSize) return refuse("too-large", `the message is longer than ${bounds.maxMessageSize}`);
            try {
                return validateMessage(decode(decodeCbor(data, cbor)), bounds);
            }
            catch (error) {
                if (error instanceof CborError) return refuse(error.code === "too-large" ? "too-large" : "invalid-message", error.message);
                if (error instanceof Unreadable) return refuse("invalid-message", error.message);
                throw error;
            }
        }
    };
}

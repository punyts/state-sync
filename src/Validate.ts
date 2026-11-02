import { CHANGE_OPS, type ChangeOp } from "./Change.js";
import { PROTOCOL_VERSION, type ErrorMessage, type SyncErrorCode, type SyncMessage } from "./Messages.js";
import { isSyncPath } from "./Paths.js";

/** The bounds parseMessage holds a message to */
export interface SyncLimits {
    /** The longest message, in characters of its JSON */
    maxMessageSize: number;
    /** The most changes in a changes or welcome message */
    maxChanges: number;
    /** The deepest nesting of a value; a primitive is depth 0 */
    maxDepth: number;
    maxPathLength: number;
    /** Change ids, client ids, error codes and emit names */
    maxIdLength: number;
    /** Ack reasons and error messages */
    maxReasonLength: number;
    maxNamespaceLength: number;
}

export const DEFAULT_SYNC_LIMITS: Readonly<SyncLimits> = Object.freeze({
    maxMessageSize: 1_000_000,
    maxChanges: 1000,
    maxDepth: 64,
    maxPathLength: 1024,
    maxIdLength: 128,
    maxReasonLength: 1024,
    maxNamespaceLength: 256
});

/** One namespace per app: dot-separated segments of letters, digits, "_" and "-" (apps.orders) */
const PATT_NAMESPACE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;

export type ParseResult =
    | { ok: true; message: SyncMessage }
    | { ok: false; error: ErrorMessage };

type Shape = Record<string, unknown>;

/** An error to stop validation with; its message is the reason sent back */
class Invalid extends Error { }

const fail = (reason: string): never => {
    throw new Invalid(reason);
};

const isPlainObject = (value: unknown): value is Shape => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
};

/**
 * Checks that the object has every required key, no key outside required and optional, and no value that is undefined
 */
const checkKeys = (value: Shape, where: string, required: readonly string[], optional: readonly string[] = []) => {
    for (const key of required) {
        if (!(key in value)) {
            fail(`${where}: missing "${key}"`);
        }
    }
    for (const key of Object.keys(value)) {
        if (!required.includes(key) && !optional.includes(key)) {
            fail(`${where}: unknown key "${key}"`);
        }
        if (value[key] === undefined) {
            fail(`${where}: "${key}" is undefined`);
        }
    }
};

const checkString = (value: unknown, where: string, maxLength: number, allowEmpty = false): string => {
    if (typeof value !== "string") {
        return fail(`${where} must be a string`);
    }
    if (!allowEmpty && value.length === 0) {
        fail(`${where} must not be empty`);
    }
    if (value.length > maxLength) {
        fail(`${where} is longer than ${maxLength}`);
    }
    return value;
};

const checkRevision = (value: unknown, where: string, min = 0) => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
        fail(`${where} must be an integer of ${min} or more`);
    }
};

/**
 * Checks that the value is a JSON value: null, a boolean, a finite number, a string, an array or a plain object of JSON
 * values, nested no deeper than maxDepth, with no "__proto__" key
 */
const checkJson = (value: unknown, where: string, maxDepth: number, depth = 0): void => {
    switch (typeof value) {
        case "string":
        case "boolean":
            return;
        case "number":
            if (!Number.isFinite(value)) {
                fail(`${where} is not a JSON value`);
            }
            return;
        case "object":
            break;
        default:
            fail(`${where} is not a JSON value`);
    }
    if (value === null) {
        return;
    }
    if (depth >= maxDepth) {
        fail(`${where} is nested deeper than ${maxDepth}`);
    }
    if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) {
            if (!(index in value)) {
                fail(`${where} is not a JSON value`);
            }
            checkJson(value[index], where, maxDepth, depth + 1);
        }
        return;
    }
    if (!isPlainObject(value)) {
        fail(`${where} is not a JSON value`);
    }
    for (const key of Object.keys(value as Shape)) {
        if (key === "__proto__") {
            fail(`${where} has a "__proto__" key`);
        }
        checkJson((value as Shape)[key], where, maxDepth, depth + 1);
    }
};

const checkChange = (value: unknown, where: string, limits: SyncLimits, revised: boolean) => {
    if (!isPlainObject(value)) {
        return fail(`${where} must be an object`);
    }
    const required = revised ? ["id", "path", "op", "base", "revision"] : ["id", "path", "op", "base"];
    checkKeys(value, where, required, ["value"]);
    checkString(value.id, `${where}.id`, limits.maxIdLength);
    const path = checkString(value.path, `${where}.path`, limits.maxPathLength);
    if (!isSyncPath(path)) {
        fail(`${where}.path is not a sync path`);
    }
    if (!CHANGE_OPS.includes(value.op as ChangeOp)) {
        fail(`${where}.op must be one of ${CHANGE_OPS.join(", ")}`);
    }
    if (value.op === "delete") {
        if ("value" in value) {
            fail(`${where}: a delete has no value`);
        }
    }
    else {
        if (!("value" in value)) {
            fail(`${where}: missing "value"`);
        }
        checkJson(value.value, `${where}.value`, limits.maxDepth);
        if (value.op === "merge" && !isPlainObject(value.value)) {
            fail(`${where}.value of a merge must be an object`);
        }
    }
    checkRevision(value.base, `${where}.base`);
    if (revised) {
        checkRevision(value.revision, `${where}.revision`, 1);
    }
};

const checkChanges = (value: unknown, where: string, limits: SyncLimits) => {
    if (!Array.isArray(value)) {
        return fail(`${where} must be an array`);
    }
    if (value.length > limits.maxChanges) {
        fail(`${where} has more than ${limits.maxChanges} changes`);
    }
    value.forEach((change, index) => checkChange(change, `${where}[${index}]`, limits, true));
};

const checkNamespace = (value: unknown, limits: SyncLimits) => {
    const namespace = checkString(value, "namespace", limits.maxNamespaceLength);
    if (!PATT_NAMESPACE.test(namespace)) {
        fail("namespace must be dot-separated segments of letters, digits, \"_\" and \"-\"");
    }
};

const checkMessage = (message: Shape, limits: SyncLimits) => {
    switch (message.type) {
        case "hello":
            checkKeys(message, "hello", ["type", "namespace", "revision", "clientId", "protocol"]);
            checkNamespace(message.namespace, limits);
            checkRevision(message.revision, "revision");
            checkString(message.clientId, "clientId", limits.maxIdLength);
            if (message.protocol !== PROTOCOL_VERSION) {
                fail(`protocol must be ${PROTOCOL_VERSION}`);
            }
            return;
        case "welcome":
            checkKeys(message, "welcome", ["type", "namespace", "revision"], ["changes", "snapshot"]);
            checkNamespace(message.namespace, limits);
            checkRevision(message.revision, "revision");
            if (("changes" in message) === ("snapshot" in message)) {
                fail("welcome must have exactly one of changes and snapshot");
            }
            if ("changes" in message) {
                checkChanges(message.changes, "changes", limits);
            }
            else {
                checkJson(message.snapshot, "snapshot", limits.maxDepth);
                if (!isPlainObject(message.snapshot)) {
                    fail("snapshot must be an object");
                }
            }
            return;
        case "changes":
            checkKeys(message, "changes", ["type", "changes"]);
            checkChanges(message.changes, "changes", limits);
            return;
        case "change":
            checkKeys(message, "change", ["type", "change"]);
            checkChange(message.change, "change", limits, false);
            return;
        case "ack":
            checkKeys(message, "ack", ["type", "id", "result"], ["revision", "value", "reason"]);
            checkString(message.id, "id", limits.maxIdLength);
            if (message.result === "applied") {
                checkKeys(message, "ack applied", ["type", "id", "result", "revision"]);
                checkRevision(message.revision, "revision", 1);
            }
            else if (message.result === "adjusted") {
                checkKeys(message, "ack adjusted", ["type", "id", "result", "revision", "value"]);
                checkRevision(message.revision, "revision", 1);
                checkJson(message.value, "value", limits.maxDepth);
            }
            else if (message.result === "rejected") {
                checkKeys(message, "ack rejected", ["type", "id", "result", "reason"]);
                checkString(message.reason, "reason", limits.maxReasonLength);
            }
            else {
                fail("result must be one of applied, adjusted, rejected");
            }
            return;
        case "emit":
            checkKeys(message, "emit", ["type", "name"], ["value"]);
            checkString(message.name, "name", limits.maxIdLength);
            if ("value" in message) {
                checkJson(message.value, "value", limits.maxDepth);
            }
            return;
        case "error":
            checkKeys(message, "error", ["type", "code", "message"]);
            checkString(message.code, "code", limits.maxIdLength);
            checkString(message.message, "message", limits.maxReasonLength, true);
            return;
        default:
            fail(typeof message.type === "string" ? `unknown type "${message.type}"` : "type must be a string");
    }
};

const refuse = (code: SyncErrorCode, message: string): ParseResult => ({
    ok: false,
    error: { type: "error", code, message }
});

/**
 * Parses and checks a sync message. A string is parsed as JSON; anything else is checked as the parsed message (a
 * postMessage payload). Each message type has a fixed set of keys: an unknown type or key, a wrong shape, a path that
 * is not a sync path, a value that is not JSON or goes past a limit is refused with an error message to send back.
 * @param input - the message JSON, or the parsed message
 * @param limits - bounds to use in place of DEFAULT_SYNC_LIMITS
 */
export const parseMessage = (input: unknown, limits: Partial<SyncLimits> = {}): ParseResult => {
    const bounds: SyncLimits = { ...DEFAULT_SYNC_LIMITS, ...limits };
    let message: unknown = input;
    if (typeof input === "string") {
        if (input.length > bounds.maxMessageSize) {
            return refuse("too-large", `the message is longer than ${bounds.maxMessageSize}`);
        }
        try {
            message = JSON.parse(input);
        }
        catch {
            return refuse("invalid-json", "the message is not JSON");
        }
    }
    if (!isPlainObject(message)) {
        return refuse("invalid-message", "the message must be an object");
    }
    try {
        checkMessage(message, bounds);
        if (typeof input !== "string" && JSON.stringify(message).length > bounds.maxMessageSize) {
            return refuse("too-large", `the message is longer than ${bounds.maxMessageSize}`);
        }
    }
    catch (error) {
        if (error instanceof Invalid) {
            return refuse("invalid-message", error.message);
        }
        throw error;
    }
    return { ok: true, message: message as unknown as SyncMessage };
};

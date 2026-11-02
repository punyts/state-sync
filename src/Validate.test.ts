import { describe, expect, it } from "vitest";
import { DEFAULT_SYNC_LIMITS, parseMessage } from "./Validate.js";

const CHANGE = Object.freeze({ id: "c1", path: "$.data.total", op: "set", value: 12, base: 3 });
const REVISED = Object.freeze({ ...CHANGE, revision: 4 });

const VALID = Object.freeze({
    hello: { type: "hello", namespace: "apps.orders", revision: 0, clientId: "tab-1", protocol: 1 },
    welcomeChanges: { type: "welcome", namespace: "apps.orders", revision: 4, changes: [REVISED] },
    welcomeSnapshot: { type: "welcome", namespace: "apps.orders", revision: 4, snapshot: { data: { total: 12 } } },
    changes: { type: "changes", changes: [REVISED] },
    change: { type: "change", change: CHANGE },
    applied: { type: "ack", id: "c1", result: "applied", revision: 4 },
    adjusted: { type: "ack", id: "c1", result: "adjusted", revision: 4, value: 10 },
    rejected: { type: "ack", id: "c1", result: "rejected", reason: "total is locked" },
    emit: { type: "emit", name: "refresh", value: { page: 2 } },
    emitNoValue: { type: "emit", name: "refresh" },
    error: { type: "error", code: "invalid-message", message: "bad" }
});

const refusal = (input: unknown, limits = {}) => {
    const result = parseMessage(input, limits);
    if (result.ok) {
        throw new Error("expected a refusal");
    }
    return result.error;
};

const change = (fields: Record<string, unknown>) => ({ type: "change", change: { ...CHANGE, ...fields } });

describe("parseMessage", () => {
    describe("valid messages", () => {
        for (const [name, message] of Object.entries(VALID)) {
            it(`should accept ${name} as an object and as JSON`, () => {
                // Act
                const fromObject = parseMessage(message);
                const fromJson = parseMessage(JSON.stringify(message));

                // Assert
                expect(fromObject).toEqual({ ok: true, message });
                expect(fromJson).toEqual({ ok: true, message });
            });
        }

        it("should accept each change op", () => {
            expect(parseMessage(change({ op: "replace", value: { a: 1 } })).ok).toBe(true);
            expect(parseMessage(change({ op: "merge", value: { a: 1 } })).ok).toBe(true);
            expect(parseMessage({ type: "change", change: { id: "c1", path: "$.data.a", op: "delete", base: 0 } }).ok).toBe(true);
        });

        it("should accept a change to $.server", () => {
            expect(parseMessage(change({ path: "$.server.keys" })).ok).toBe(true);
        });

        it("should accept null and nested JSON values", () => {
            expect(parseMessage(change({ value: null })).ok).toBe(true);
            expect(parseMessage(change({ value: [1, "a", true, null, { b: [] }] })).ok).toBe(true);
        });
    });

    describe("refused input", () => {
        it("should refuse text that is not JSON", () => {
            expect(refusal("{nope").code).toBe("invalid-json");
        });

        it("should refuse a message that is not an object", () => {
            expect(refusal("[1]").code).toBe("invalid-message");
            expect(refusal(null).code).toBe("invalid-message");
            expect(refusal("12").code).toBe("invalid-message");
        });

        it("should refuse text longer than the size limit", () => {
            // Arrange
            const text = JSON.stringify(VALID.emit);

            // Act
            const error = refusal(text, { maxMessageSize: text.length - 1 });

            // Assert
            expect(error).toEqual({ type: "error", code: "too-large", message: expect.any(String) });
        });

        it("should refuse an object larger than the size limit", () => {
            expect(refusal(VALID.emit, { maxMessageSize: 10 }).code).toBe("too-large");
        });

        it("should refuse an unknown type and a missing type", () => {
            expect(refusal({ type: "subscribe" }).message).toContain("unknown type");
            expect(refusal({ namespace: "a" }).message).toContain("type");
        });

        it("should refuse an unknown key", () => {
            expect(refusal({ ...VALID.hello, token: "x" }).message).toContain("unknown key \"token\"");
            expect(refusal(change({ extra: 1 })).message).toContain("unknown key \"extra\"");
        });

        it("should refuse a missing key", () => {
            const { clientId: _clientId, ...hello } = VALID.hello;
            expect(refusal(hello).message).toContain("missing \"clientId\"");
        });
    });

    describe("hello", () => {
        it("should refuse another protocol version", () => {
            expect(refusal({ ...VALID.hello, protocol: 2 }).message).toContain("protocol");
        });

        it("should refuse a bad namespace", () => {
            expect(refusal({ ...VALID.hello, namespace: "apps/orders" }).message).toContain("namespace");
            expect(refusal({ ...VALID.hello, namespace: "apps." }).message).toContain("namespace");
            expect(refusal({ ...VALID.hello, namespace: "" }).message).toContain("namespace");
        });

        it("should refuse a namespace longer than the limit", () => {
            expect(refusal(VALID.hello, { maxNamespaceLength: 5 }).message).toContain("namespace");
        });

        it("should refuse a negative or fractional revision", () => {
            expect(refusal({ ...VALID.hello, revision: -1 }).message).toContain("revision");
            expect(refusal({ ...VALID.hello, revision: 1.5 }).message).toContain("revision");
            expect(refusal({ ...VALID.hello, revision: "1" }).message).toContain("revision");
        });
    });

    describe("welcome", () => {
        it("should refuse both changes and snapshot, and neither", () => {
            expect(refusal({ ...VALID.welcomeChanges, snapshot: {} }).message).toContain("exactly one");
            const { changes: _changes, ...neither } = VALID.welcomeChanges;
            expect(refusal(neither).message).toContain("exactly one");
        });

        it("should refuse a snapshot that is not an object", () => {
            expect(refusal({ ...VALID.welcomeSnapshot, snapshot: [1] }).message).toContain("snapshot");
        });

        it("should refuse a change without a revision", () => {
            expect(refusal({ ...VALID.welcomeChanges, changes: [CHANGE] }).message).toContain("missing \"revision\"");
        });
    });

    describe("changes", () => {
        it("should refuse more changes than the limit", () => {
            expect(refusal({ type: "changes", changes: [REVISED, REVISED] }, { maxChanges: 1 }).message).toContain("more than 1");
        });

        it("should refuse a revision below 1", () => {
            expect(refusal({ type: "changes", changes: [{ ...REVISED, revision: 0 }] }).message).toContain("revision");
        });

        it("should refuse changes that are not an array", () => {
            expect(refusal({ type: "changes", changes: REVISED }).message).toContain("array");
        });
    });

    describe("change", () => {
        it("should refuse a path that is not a sync path", () => {
            expect(refusal(change({ path: "$" })).message).toContain("sync path");
            expect(refusal(change({ path: "$.runtime.x" })).message).toContain("sync path");
            expect(refusal(change({ path: "data.total" })).message).toContain("sync path");
            expect(refusal(change({ path: "$.data.__proto__" })).message).toContain("sync path");
        });

        it("should refuse a path longer than the limit", () => {
            expect(refusal(change({}), { maxPathLength: 4 }).message).toContain("path");
        });

        it("should refuse an unknown op", () => {
            expect(refusal(change({ op: "push" })).message).toContain("op");
        });

        it("should refuse a delete with a value and a set without one", () => {
            expect(refusal(change({ op: "delete" })).message).toContain("delete has no value");
            const { value: _value, ...set } = CHANGE;
            expect(refusal({ type: "change", change: set }).message).toContain("missing \"value\"");
        });

        it("should refuse a merge whose value is not an object", () => {
            expect(refusal(change({ op: "merge", value: [1] })).message).toContain("merge");
        });

        it("should refuse an empty id and an id longer than the limit", () => {
            expect(refusal(change({ id: "" })).message).toContain("id");
            expect(refusal(change({ id: "x".repeat(DEFAULT_SYNC_LIMITS.maxIdLength + 1) })).message).toContain("id");
        });

        it("should refuse a value that is not JSON", () => {
            expect(refusal(change({ value: Number.NaN })).message).toContain("not a JSON value");
            expect(refusal(change({ value: Infinity })).message).toContain("not a JSON value");
            expect(refusal(change({ value: () => 1 })).message).toContain("not a JSON value");
            expect(refusal(change({ value: new Date() })).message).toContain("not a JSON value");
            expect(refusal(change({ value: [1, , 3] })).message).toContain("not a JSON value");
            expect(refusal(change({ value: undefined })).message).toContain("undefined");
        });

        it("should refuse a value nested deeper than the limit", () => {
            expect(parseMessage(change({ value: { a: { b: 1 } } }), { maxDepth: 2 }).ok).toBe(true);
            expect(refusal(change({ value: { a: { b: { c: 1 } } } }), { maxDepth: 2 }).message).toContain("deeper");
        });

        it("should refuse a __proto__ key in a value", () => {
            expect(refusal(JSON.stringify(change({})).replace("12", "{\"__proto__\":{\"x\":1}}")).message).toContain("__proto__");
        });
    });

    describe("ack", () => {
        it("should refuse applied without a revision", () => {
            expect(refusal({ type: "ack", id: "c1", result: "applied" }).message).toContain("missing \"revision\"");
        });

        it("should refuse adjusted without a value", () => {
            expect(refusal({ type: "ack", id: "c1", result: "adjusted", revision: 4 }).message).toContain("missing \"value\"");
        });

        it("should refuse rejected without a reason, and with a revision", () => {
            expect(refusal({ type: "ack", id: "c1", result: "rejected" }).message).toContain("missing \"reason\"");
            expect(refusal({ ...VALID.rejected, revision: 4 }).message).toContain("unknown key \"revision\"");
        });

        it("should refuse a reason in an applied ack", () => {
            expect(refusal({ ...VALID.applied, reason: "x" }).message).toContain("unknown key \"reason\"");
        });

        it("should refuse an unknown result", () => {
            expect(refusal({ type: "ack", id: "c1", result: "maybe" }).message).toContain("result");
        });

        it("should refuse a reason longer than the limit", () => {
            expect(refusal(VALID.rejected, { maxReasonLength: 3 }).message).toContain("reason");
        });
    });

    describe("emit and error", () => {
        it("should refuse an emit without a name or with a value that is not JSON", () => {
            expect(refusal({ type: "emit" }).message).toContain("missing \"name\"");
            expect(refusal({ type: "emit", name: "x", value: Number.NaN }).message).toContain("not a JSON value");
        });

        it("should refuse an error without a code", () => {
            expect(refusal({ type: "error", message: "bad" }).message).toContain("missing \"code\"");
        });
    });
});

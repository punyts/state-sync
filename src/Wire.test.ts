import { describe, expect, it } from "vitest";
import { decodeCbor, encodeCbor } from "./Cbor.js";
import type { JsonValue } from "./Change.js";
import type { SyncMessage, SyncRequest } from "./Messages.js";
import { DEFAULT_SYNC_LIMITS } from "./Validate.js";
import { createSyncWire, MAX_WIRE_PATHS, wireTypeOf } from "./Wire.js";

const UUID = "0f8fad5b-d9cb-469f-a165-70867728950e";

const REQUEST: SyncRequest = {
    id: "r1", path: "$.data.notes.n1", op: "set", value: { text: "Hello" }, base: 3, by: "bob", mine: true,
    at: 1_800_000_000_000, until: 1_800_604_800_000, status: "rejected", decidedAt: 1_800_000_100_000, code: "logic", note: "not today"
};

/** One message of every type, each with its optional fields */
const MESSAGES: SyncMessage[] = [
    { type: "welcome", namespace: "alice.notes", revision: 7, snapshot: { data: { total: 1.5 } }, durable: 6, requests: [REQUEST] },
    { type: "welcome", namespace: "alice.notes", revision: 7, changes: [{ revision: 7, id: UUID, path: "$.data.total", op: "merge", value: { a: 1 }, base: 6 }] },
    { type: "changes", changes: [
        { revision: 8, id: "c1", path: "$.app.pointer", op: "set", value: { x: 1, y: -2 }, base: 7, ephemeral: true },
        { revision: 9, id: "c2", path: "$.data.gone", op: "delete", base: 8 }
    ] },
    { type: "durable", revision: 9 },
    { type: "change", change: { id: UUID, path: "$.data.total", op: "replace", value: [1, "two", null, true], base: 9 } },
    { type: "ack", id: "c3", result: "applied", revision: 10 },
    { type: "ack", id: "c4", result: "adjusted", revision: 11, value: 12 },
    { type: "ack", id: "c5", result: "rejected", reason: "no write", code: "access" },
    { type: "ack", id: "c6", result: "requested" },
    { type: "requested", request: { ...REQUEST, status: "pending", decidedAt: undefined, code: undefined, note: undefined } },
    { type: "decided", id: "r1", status: "rejected", decidedAt: 1_800_000_100_000, code: "logic", note: "not today" },
    { type: "decided", id: "r2", status: "approved", decidedAt: 1_800_000_100_000 },
    { type: "approve", id: "r1" },
    { type: "reject", id: "r1", note: "no" },
    { type: "reject", id: UUID },
    { type: "withdraw", id: "r1" },
    { type: "emit", name: "pinged", value: { at: 1 } },
    { type: "emit", name: "pinged" }
];

/** The message without its undefined fields, as JSON would carry it */
const plain = (message: SyncMessage): SyncMessage => JSON.parse(JSON.stringify(message)) as SyncMessage;

describe("createSyncWire", () => {
    it("should carry every message type through and back, binary but for hello and error", () => {
        // Arrange
        const sender = createSyncWire();
        const receiver = createSyncWire();
        const hello: SyncMessage = { type: "hello", namespace: "alice.notes", revision: 0, clientId: "tab-1", protocol: 4 };
        const error: SyncMessage = { type: "error", code: "not-allowed", message: "no" };

        // Act
        const written = [hello, ...MESSAGES, error].map((message) => sender.write(message));
        const read = written.map((data) => receiver.read(data));

        // Assert
        expect(typeof written[0]).toBe("string");
        expect(typeof written.at(-1)).toBe("string");
        expect(written.slice(1, -1).every((data) => data instanceof Uint8Array)).toBe(true);
        expect(read).toEqual([hello, ...MESSAGES, error].map((message) => ({ ok: true, message: plain(message) })));
    });

    it("should send a path as text with its number the first time, then as the number alone", () => {
        // Arrange
        const wire = createSyncWire();
        const change = (id: string, path: string): SyncMessage => ({ type: "change", change: { id, path, op: "set", value: 1, base: 0 } });

        // Act
        const first = decodeCbor(wire.write(change("a", "$.data.total")) as Uint8Array);
        const second = decodeCbor(wire.write(change("b", "$.data.total")) as Uint8Array);
        const other = decodeCbor(wire.write(change("c", "$.data.count")) as Uint8Array);

        // Assert
        expect(first).toEqual([5, ["a", [0, "$.data.total"], 0, 0, 1]]);
        expect(second).toEqual([5, ["b", 0, 0, 0, 1]]);
        expect(other).toEqual([5, ["c", [1, "$.data.count"], 0, 0, 1]]);
    });

    it("should send paths past the table's size as text", () => {
        // Arrange
        const sender = createSyncWire();
        const receiver = createSyncWire();
        const change = (index: number) => ({ revision: index + 1, id: `c${index}`, path: `$.data.p${index}`, op: "set" as const, value: index, base: index });
        const batches = Array.from({ length: Math.ceil((MAX_WIRE_PATHS + 1) / 1000) }, (_, batch) =>
            Array.from({ length: Math.min(1000, MAX_WIRE_PATHS + 1 - batch * 1000) }, (_, index) => change(batch * 1000 + index)));

        // Act
        const written = batches.map((changes) => sender.write({ type: "changes", changes }) as Uint8Array);
        const read = written.map((data) => receiver.read(data));
        const last = decodeCbor(written.at(-1) as Uint8Array) as [number, unknown[][]];

        // Assert
        expect(read).toEqual(batches.map((changes) => ({ ok: true, message: { type: "changes", changes } })));
        expect(last[1].at(-2)?.[2]).toEqual([MAX_WIRE_PATHS - 1, `$.data.p${MAX_WIRE_PATHS - 1}`]);
        expect(last[1].at(-1)?.[2]).toBe(`$.data.p${MAX_WIRE_PATHS}`);
    });

    it("should send a lowercase uuid id as 16 bytes and any other id as text", () => {
        // Arrange
        const wire = createSyncWire();

        // Act
        const uuid = decodeCbor(wire.write({ type: "approve", id: UUID }) as Uint8Array, { bytes: true }) as unknown[];
        const upper = decodeCbor(wire.write({ type: "approve", id: UUID.toUpperCase() }) as Uint8Array, { bytes: true }) as unknown[];

        // Assert
        expect(uuid[1]).toEqual(new Uint8Array([0x0f, 0x8f, 0xad, 0x5b, 0xd9, 0xcb, 0x46, 0x9f, 0xa1, 0x65, 0x70, 0x86, 0x77, 0x28, 0x95, 0x0e]));
        expect(upper[1]).toBe(UUID.toUpperCase());
    });

    it("should number a welcome's request paths before its change paths, as it writes them", () => {
        // Arrange
        const sender = createSyncWire();
        const receiver = createSyncWire();
        const welcome: SyncMessage = {
            type: "welcome", namespace: "alice.notes", revision: 2, durable: 2, requests: [REQUEST],
            changes: [{ revision: 2, id: "c1", path: "$.data.total", op: "set", value: 1, base: 1 }]
        };
        const later: SyncMessage = { type: "changes", changes: [
            { revision: 3, id: "c2", path: REQUEST.path, op: "set", value: 2, base: 2 },
            { revision: 4, id: "c3", path: "$.data.total", op: "set", value: 3, base: 3 }
        ] };

        // Act
        receiver.read(sender.write(welcome));
        const read = receiver.read(sender.write(later));

        // Assert
        expect(read).toEqual({ ok: true, message: later });
    });

    it("should write and read a change whose value is as deep as the limits allow", () => {
        // Arrange
        const sender = createSyncWire();
        const receiver = createSyncWire();
        let value: JsonValue = 1;
        for (let level = 0; level < DEFAULT_SYNC_LIMITS.maxDepth - 1; level++) value = { v: value };
        const message: SyncMessage = { type: "changes", changes: [{ revision: 1, id: "c1", path: "$.data.deep", op: "set", value, base: 0 }] };

        // Act
        const read = receiver.read(sender.write(message));

        // Assert
        expect(read).toEqual({ ok: true, message });
    });

    it("should refuse a message that is not hello or error as text, and a hello as bytes", () => {
        // Arrange
        const wire = createSyncWire();
        const hello = { type: "hello", namespace: "alice.notes", revision: 0, clientId: "tab-1", protocol: 4 };

        // Act
        const text = wire.read(JSON.stringify({ type: "durable", revision: 1 }));
        const binary = wire.read(encodeCbor([1, hello.namespace, 0, hello.clientId, 4]));

        // Assert
        expect(text).toMatchObject({ ok: false, error: { code: "invalid-message", message: "a durable must be binary" } });
        expect(binary).toMatchObject({ ok: false, error: { code: "invalid-message", message: "unknown message code 1" } });
    });

    it("should refuse a hello of protocol 3 as invalid-message", () => {
        // Arrange
        const wire = createSyncWire();

        // Act
        const read = wire.read(JSON.stringify({ type: "hello", namespace: "alice.notes", revision: 0, clientId: "tab-1", protocol: 3 }));

        // Assert
        expect(read).toMatchObject({ ok: false, error: { code: "invalid-message" } });
    });

    it("should refuse a path number never sent, a new path out of order, and an op outside its list", () => {
        // Arrange
        const read = (value: unknown) => createSyncWire().read(encodeCbor(value as never));

        // Act
        const unknown = read([5, ["a", 3, 0, 0, 1]]);
        const skipped = read([5, ["a", [1, "$.data.total"], 0, 0, 1]]);
        const op = read([5, ["a", "$.data.total", 9, 0, 1]]);

        // Assert
        expect(unknown).toMatchObject({ ok: false, error: { code: "invalid-message", message: "path 3 was not sent before" } });
        expect(skipped).toMatchObject({ ok: false, error: { code: "invalid-message", message: "a new path must be numbered 0" } });
        expect(op).toMatchObject({ ok: false, error: { code: "invalid-message", message: "a change's op is not one of 4" } });
    });

    it("should refuse bytes past the message size as too-large, and bytes that are not CBOR as invalid-message", () => {
        // Arrange
        const wire = createSyncWire({ maxMessageSize: 64 });

        // Act
        const large = wire.read(new Uint8Array(65));
        const broken = wire.read(new Uint8Array([0x85, 0x05]));

        // Assert
        expect(large).toMatchObject({ ok: false, error: { code: "too-large" } });
        expect(broken).toMatchObject({ ok: false, error: { code: "invalid-message" } });
    });

    it("should check a decoded message as a parsed one, so a bad field is refused without its value", () => {
        // Arrange
        const wire = createSyncWire();

        // Act
        const read = wire.read(encodeCbor([5, ["a", "data.secret", 0, 0, "hunter2"]]));

        // Assert
        expect(read).toMatchObject({ ok: false, error: { code: "invalid-message" } });
        expect(JSON.stringify(read)).not.toContain("hunter2");
    });

    it("should tell the type of a binary message from its first bytes, and nothing of text or of bytes that are no message", () => {
        // Arrange
        const wire = createSyncWire();

        // Act
        const types = MESSAGES.map((message) => wireTypeOf(wire.write(message)));

        // Assert
        expect(types).toEqual(MESSAGES.map((message) => message.type));
        expect(wireTypeOf(JSON.stringify({ type: "hello" }))).toBeUndefined();
        expect(wireTypeOf(new Uint8Array([0x82, 0x01]))).toBeUndefined();
        expect(wireTypeOf(new Uint8Array([0xa1, 0x05]))).toBeUndefined();
    });
});

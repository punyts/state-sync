import { describe, expect, it } from "vitest";
import type { JsonValue } from "./Change.js";
import { CborError, decodeCbor, encodeCbor } from "./Cbor.js";
import type { CborErrorCode, CborLimits } from "./Cbor.js";

const hex = (bytes: Uint8Array): string => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const bytesOf = (text: string): Uint8Array => new Uint8Array((text.match(/../g) ?? []).map((pair) => parseInt(pair, 16)));

/** The code a call throws, or "none" */
const codeOf = (call: () => unknown): CborErrorCode | "none" => {
    try {
        call();
        return "none";
    }
    catch (error) {
        if (error instanceof CborError) return error.code;
        throw error;
    }
};

const decodeHex = (text: string, limits?: Partial<CborLimits>): CborErrorCode | "none" =>
    codeOf(() => decodeCbor(bytesOf(text), limits === undefined ? {} : { limits }));

/** A seeded generator (mulberry32), so a failing value can be found again */
const generator = (seed: number) => {
    let state = seed >>> 0;
    const next = (): number => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const below = (n: number): number => Math.floor(next() * n);
    const NUMBERS = [0, -0, 1, -1, 23, 24, 255, 256, 65535, 65536, 2 ** 32, 2 ** 53 - 1, -(2 ** 53 - 1), 2 ** 60, 0.5, 1.1, -3.25, 1e-300, 1.7976931348623157e308];
    const CHARACTERS = ["a", "z", "0", " ", "\"", "\\", "\n", "ü", "€", "😀", "\u0000", "$", "."];
    const text = (): string => Array.from({ length: below(12) }, () => CHARACTERS[below(CHARACTERS.length)] as string).join("");
    const number = (): number => {
        switch (below(4)) {
            case 0: return NUMBERS[below(NUMBERS.length)] as number;
            case 1: return below(2_000_000) - 1_000_000;
            case 2: return (next() - 0.5) * 10 ** below(20);
            default: return Math.fround(next() * 1000);
        }
    };
    const value = (depth: number): JsonValue => {
        const kind = below(depth > 4 ? 4 : 6);
        switch (kind) {
            case 0: return null;
            case 1: return next() < 0.5;
            case 2: return number();
            case 3: return text();
            case 4: return Array.from({ length: below(6) }, () => value(depth + 1));
            default: {
                const map: { [key: string]: JsonValue } = {};
                for (let index = below(6); index > 0; index--) map[`${text()}${below(3) === 0 ? index : ""}`] = value(depth + 1);
                return map;
            }
        }
    };
    return { value };
};

describe("encodeCbor and decodeCbor", () => {
    it("should encode the RFC 8949 examples the subset holds, in their shortest form", () => {
        // Arrange
        const examples: Array<[JsonValue, string]> = [
            [0, "00"], [23, "17"], [24, "1818"], [100, "1864"], [1000, "1903e8"], [1000000, "1a000f4240"],
            [1000000000000, "1b000000e8d4a51000"], [-1, "20"], [-1000, "3903e7"], [1.1, "fb3ff199999999999a"],
            [1.5, "fa3fc00000"], [-4.1, "fbc010666666666666"], [false, "f4"], [true, "f5"], [null, "f6"], ["", "60"],
            ["a", "6161"], ["ü", "62c3bc"], ["𐅑", "64f0908591"], [[], "80"],
            [[1, [2, 3], [4, 5]], "8301820203820405"], [{ a: 1, b: [2, 3] }, "a26161016162820203"]
        ];

        // Act
        const encoded = examples.map(([value]) => hex(encodeCbor(value)));

        // Assert
        expect(encoded).toEqual(examples.map(([, bytes]) => bytes));
    });

    it("should decode every float width, and write -0 and integers past 2^53 - 1 as JSON writes them", () => {
        // Act
        const halves = ["f93c00", "f97bff", "f90001", "f9c400", "f98000"].map((text) => decodeCbor(bytesOf(text)));
        const zero = hex(encodeCbor(-0));
        const big = decodeCbor(encodeCbor(2 ** 60));

        // Assert
        expect(halves).toEqual([1, 65504, 5.960464477539063e-8, -4, 0]);
        expect(Object.is(halves[4], -0)).toBe(false);
        expect(zero).toBe("00");
        expect(big).toBe(2 ** 60);
    });

    it("should keep a map's keys in the order they were written, and make __proto__ an own key as JSON.parse does", () => {
        // Arrange
        const value = JSON.parse("{\"zeta\":1,\"alpha\":{\"__proto__\":{\"polluted\":true},\"m\":[]},\"beta\":null}") as JsonValue;

        // Act
        const decoded = decodeCbor(encodeCbor(value)) as { [key: string]: { [key: string]: JsonValue } };

        // Assert
        expect(Object.keys(decoded)).toEqual(["zeta", "alpha", "beta"]);
        expect(Object.keys(decoded["alpha"] as object)).toEqual(["__proto__", "m"]);
        expect(({} as { polluted?: boolean }).polluted).toBeUndefined();
        expect(JSON.stringify(decoded)).toBe(JSON.stringify(value));
    });

    it("should decode what JSON text would, for generated values", () => {
        // Arrange
        const { value } = generator(20261123);
        const values = Array.from({ length: 2000 }, () => value(0));

        // Act
        const decoded = values.map((item) => JSON.stringify(decodeCbor(encodeCbor(item))));

        // Assert
        expect(decoded).toEqual(values.map((item) => JSON.stringify(JSON.parse(JSON.stringify(item)))));
    });

    it("should write and read strings on both sides of the short ASCII path", () => {
        // Arrange
        const strings = ["x".repeat(64), "x".repeat(65), `${"x".repeat(63)}ü`, `€${"y".repeat(200)}`, "$.data.orders.o12.lines.l0.quantity"];

        // Act
        const decoded = strings.map((item) => decodeCbor(encodeCbor(item)));
        const head = hex(encodeCbor("x".repeat(64))).slice(0, 4);

        // Assert
        expect(decoded).toEqual(strings);
        expect(head).toBe("7840");
    });

    it("should refuse to encode what JSON does not hold", () => {
        // Act
        const codes = [NaN, Infinity, -Infinity, undefined, () => 1, 1n, new Date(0), new Uint8Array(2), { a: undefined }, [Symbol("s")]]
            .map((item) => codeOf(() => encodeCbor(item as JsonValue)));
        const deep = codeOf(() => encodeCbor(Array.from({ length: 65 }).reduce<JsonValue>((inner) => [inner], 0)));

        // Assert
        expect(codes).toEqual(Array.from({ length: 10 }, () => "unsupported"));
        expect(deep).toBe("too-deep");
    });

    it("should leave out a member that is undefined only when asked to, and write as deep as it is told", () => {
        // Arrange
        const value = { a: 1, gone: undefined, b: [2] } as unknown as JsonValue;
        let deep: JsonValue = 1;
        for (let level = 0; level < 70; level++) deep = [deep];

        // Act
        const omitted = decodeCbor(encodeCbor(value, { omitUndefined: true }));
        const refused = codeOf(() => encodeCbor(value));
        const tooDeep = codeOf(() => encodeCbor(deep));
        const deeper = decodeCbor(encodeCbor(deep, { maxDepth: 80 }), { limits: { maxDepth: 80 } });

        // Assert
        expect(omitted).toEqual({ a: 1, b: [2] });
        expect(Object.keys(omitted as object)).toEqual(["a", "b"]);
        expect(refused).toBe("unsupported");
        expect(tooDeep).toBe("too-deep");
        expect(deeper).toEqual(deep);
    });

    it("should carry byte strings only when asked to", () => {
        // Arrange
        const id = bytesOf("0f1e2d3c4b5a69788796a5b4c3d2e1f0");

        // Act
        const encoded = encodeCbor(["change", id], { bytes: true });
        const decoded = decodeCbor(encoded, { bytes: true });
        const refused = codeOf(() => decodeCbor(encoded));

        // Assert
        expect(hex(encoded)).toBe(`82666368616e676550${hex(id)}`);
        expect(decoded).toEqual(["change", id]);
        expect((decoded as unknown[])[1]).toBeInstanceOf(Uint8Array);
        expect(refused).toBe("unsupported");
    });

    it("should refuse CBOR the subset does not carry, and input that is not well formed", () => {
        // Arrange: a tag, undefined, a simple value, NaN, an infinity, an indefinite array, an integer key, an integer
        // past 2^53 - 1 both ways; then a repeated key, bytes after the value, a value cut short, invalid UTF-8, a
        // reserved head, a lone break
        const unsupported = ["c11a514b67b0", "f7", "e0", "f97e00", "f97c00", "9f01ff", "a10102", "1b0020000000000000", "3b001fffffffffffff"];
        const malformed = ["a2616101616102", "0000", "1903", "62c328", "1c", "ff"];

        // Act
        const codes = [...unsupported, ...malformed].map((text) => decodeHex(text));

        // Assert
        expect(codes).toEqual([...unsupported.map(() => "unsupported"), ...malformed.map(() => "malformed")]);
    });

    it("should refuse input past its limits before allocating for it", () => {
        // Arrange: an array that claims a billion members, one of 50 under a limit of 10 values, a string that claims
        // 4 GB, nesting one deeper than allowed, and an input longer than allowed
        const claimsBillion = "9a3b9aca00" + "00".repeat(16);
        const fifty = "9832" + "00".repeat(50);
        const hugeString = "7affffffff" + "61".repeat(8);
        const nested = "81".repeat(65) + "00";

        // Act
        const codes = [
            decodeHex(claimsBillion),
            decodeHex(fifty, { maxItems: 10 }),
            decodeHex(fifty),
            decodeHex(hugeString, { maxStringBytes: 1024 }),
            decodeHex(nested),
            decodeHex("81".repeat(64) + "00"),
            decodeHex("00", { maxBytes: 0 })
        ];

        // Assert
        expect(codes).toEqual(["malformed", "too-large", "none", "too-large", "too-deep", "none", "too-large"]);
    });

    it("should say where it refused without saying what it read", () => {
        // Act
        let message = "";
        try {
            decodeCbor(bytesOf("a266736563726574016673656372657402")); // { "secret": 1, "secret": 2 }
        }
        catch (error) {
            message = (error as Error).message;
        }

        // Assert
        expect(message).toMatch(/at byte \d+$/);
        expect(message).not.toContain("secret");
    });
});

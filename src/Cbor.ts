import type { JsonValue } from "./Change.js";

/**
 * A subset of CBOR (RFC 8949) for the sync and mesh wire (docs/design/statenet-wire-format.md, W1): the values JSON
 * holds, and byte strings when the caller asks for them. Maps keep the order their keys were written in, lengths are
 * definite, heads take their shortest form, and a float is a float32 when that holds it exactly. Decoding refuses anything JSON could not carry
 * (undefined, tags, simple values other than true, false and null, NaN and infinities, keys that are not text,
 * repeated keys), so a decoded value is always a `JsonValue` tree, and it refuses input past its limits before it
 * allocates for it. Strings are UTF-8: a lone surrogate becomes U+FFFD, as it does when JSON text goes out on a socket.
 */

/** The bounds a decoder holds untrusted bytes to */
export interface CborLimits {
    /** The longest input, in bytes */
    maxBytes: number;
    /** The deepest nesting of arrays and maps; the top value is at depth 0 */
    maxDepth: number;
    /** The most values in one input, counting every array member, map key and map value */
    maxItems: number;
    /** The longest text or byte string, in bytes */
    maxStringBytes: number;
}

export const DEFAULT_CBOR_LIMITS: Readonly<CborLimits> = Object.freeze({
    maxBytes: 1_000_000,
    maxDepth: 64,
    maxItems: 100_000,
    maxStringBytes: 1_000_000
});

/** A value the codec carries: JSON's, and byte strings when `bytes` is on */
export type CborValue = null | boolean | number | string | Uint8Array | CborValue[] | { [key: string]: CborValue };

/**
 * Why a value was not encoded or decoded. Messages name the kind and the byte offset, never a value
 * - too-large: past `maxBytes`, `maxItems` or `maxStringBytes`
 * - too-deep: past `maxDepth`
 * - malformed: not well-formed CBOR, invalid UTF-8, a repeated key, or bytes after the value
 * - unsupported: well-formed CBOR this subset does not carry
 */
export type CborErrorCode = "too-large" | "too-deep" | "malformed" | "unsupported";

export class CborError extends Error {
    constructor(readonly code: CborErrorCode, message: string) {
        super(message);
        this.name = "CborError";
    }
}

export interface CborOptions {
    /** Carry byte strings (`Uint8Array`); off by default, when a byte string is `unsupported` */
    bytes?: boolean;
}

export interface CborEncodeOptions extends CborOptions {
    /** Leave out a map member whose value is undefined, as `JSON.stringify` does, instead of refusing it */
    omitUndefined?: boolean;
    /** The deepest nesting written; `DEFAULT_CBOR_LIMITS.maxDepth` by default */
    maxDepth?: number;
}

export interface CborDecodeOptions extends CborOptions {
    limits?: Partial<CborLimits>;
}

const MAJOR_UNSIGNED = 0;
const MAJOR_NEGATIVE = 1;
const MAJOR_BYTES = 2;
const MAJOR_TEXT = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;
const MAJOR_TAG = 6;
const MAJOR_SIMPLE = 7;

const FALSE = 0xf4;
const TRUE = 0xf5;
const NULL = 0xf6;
const FLOAT32 = 0xfa;
const FLOAT64 = 0xfb;

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/** A growing buffer the encoder writes into */
class Writer {
    private buffer = new Uint8Array(256);
    private view = new DataView(this.buffer.buffer);
    private length = 0;

    private reserve(count: number): void {
        if (this.length + count <= this.buffer.length) return;
        let size = this.buffer.length * 2;
        while (size < this.length + count) size *= 2;
        const next = new Uint8Array(size);
        next.set(this.buffer.subarray(0, this.length));
        this.buffer = next;
        this.view = new DataView(next.buffer);
    }

    byte(value: number): void {
        this.reserve(1);
        this.buffer[this.length++] = value;
    }

    /** A head: the major type and its argument in the fewest bytes */
    head(major: number, argument: number): void {
        const type = major << 5;
        if (argument < 24) {
            this.byte(type | argument);
        }
        else if (argument < 0x100) {
            this.reserve(2);
            this.buffer[this.length++] = type | 24;
            this.buffer[this.length++] = argument;
        }
        else if (argument < 0x10000) {
            this.reserve(3);
            this.buffer[this.length++] = type | 25;
            this.view.setUint16(this.length, argument);
            this.length += 2;
        }
        else if (argument < 0x100000000) {
            this.reserve(5);
            this.buffer[this.length++] = type | 26;
            this.view.setUint32(this.length, argument);
            this.length += 4;
        }
        else {
            this.reserve(9);
            this.buffer[this.length++] = type | 27;
            this.view.setBigUint64(this.length, BigInt(argument));
            this.length += 8;
        }
    }

    float(value: number): void {
        if (Math.fround(value) === value) {
            this.reserve(5);
            this.buffer[this.length++] = FLOAT32;
            this.view.setFloat32(this.length, value);
            this.length += 4;
        }
        else {
            this.reserve(9);
            this.buffer[this.length++] = FLOAT64;
            this.view.setFloat64(this.length, value);
            this.length += 8;
        }
    }

    /** A text string; ASCII is written byte by byte, which is faster than a TextEncoder call for short strings */
    text(value: string): void {
        const length = value.length;
        if (length <= 64) {
            let ascii = true;
            for (let index = 0; index < length; index++) {
                if (value.charCodeAt(index) > 0x7f) {
                    ascii = false;
                    break;
                }
            }
            if (ascii) {
                this.head(MAJOR_TEXT, length);
                this.reserve(length);
                for (let index = 0; index < length; index++) this.buffer[this.length++] = value.charCodeAt(index);
                return;
            }
        }
        const encoded = utf8Encoder.encode(value);
        this.head(MAJOR_TEXT, encoded.length);
        this.bytes(encoded);
    }

    bytes(value: Uint8Array): void {
        this.reserve(value.length);
        this.buffer.set(value, this.length);
        this.length += value.length;
    }

    result(): Uint8Array {
        return this.buffer.slice(0, this.length);
    }
}

const isPlainObject = (value: object): boolean => {
    const prototype: unknown = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
};

/**
 * Encodes a value as CBOR. A safe integer is a CBOR integer (-0 as 0, as JSON writes it), another number a float32
 * when that holds it exactly, else a float64. NaN, infinities, `undefined` (but a map member's with `omitUndefined`),
 * a byte string without `bytes`, and anything that is not a JSON value throw `unsupported`; nesting past `maxDepth`
 * throws `too-deep`
 */
export function encodeCbor(value: JsonValue | CborValue, options: CborEncodeOptions = {}): Uint8Array {
    const writer = new Writer();
    const bytes = options.bytes === true;
    const omit = options.omitUndefined === true;
    const maxDepth = options.maxDepth ?? DEFAULT_CBOR_LIMITS.maxDepth;

    const write = (item: unknown, depth: number): void => {
        if (item === null) {
            writer.byte(NULL);
            return;
        }
        switch (typeof item) {
            case "boolean":
                writer.byte(item ? TRUE : FALSE);
                return;
            case "number":
                if (!Number.isFinite(item)) throw new CborError("unsupported", "a number must be finite");
                if (Number.isSafeInteger(item)) {
                    if (item >= 0) writer.head(MAJOR_UNSIGNED, item);
                    else writer.head(MAJOR_NEGATIVE, -1 - item);
                }
                else {
                    writer.float(item);
                }
                return;
            case "string":
                writer.text(item);
                return;
            case "object":
                break;
            default:
                throw new CborError("unsupported", `a ${typeof item} is not a JSON value`);
        }
        if (item instanceof Uint8Array) {
            if (!bytes) throw new CborError("unsupported", "a byte string needs the bytes option");
            writer.head(MAJOR_BYTES, item.length);
            writer.bytes(item);
            return;
        }
        if (depth >= maxDepth) throw new CborError("too-deep", `nesting is deeper than ${maxDepth}`);
        if (Array.isArray(item)) {
            writer.head(MAJOR_ARRAY, item.length);
            for (const member of item) write(member, depth + 1);
            return;
        }
        if (!isPlainObject(item)) throw new CborError("unsupported", "an object must be a plain object");
        const keys = omit ? Object.keys(item).filter((key) => (item as Record<string, unknown>)[key] !== undefined) : Object.keys(item);
        writer.head(MAJOR_MAP, keys.length);
        for (const key of keys) {
            write(key, depth + 1);
            write((item as Record<string, unknown>)[key], depth + 1);
        }
    };

    write(value, 0);
    return writer.result();
}

/** Decodes a float16 (IEEE 754 half precision) */
const half = (bits: number): number => {
    const exponent = (bits >> 10) & 0x1f;
    const fraction = bits & 0x3ff;
    const sign = bits & 0x8000 ? -1 : 1;
    if (exponent === 0) return sign * fraction * 2 ** -24;
    if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN;
    return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
};

/**
 * Decodes one CBOR value that fills the input. Throws `CborError`: `too-large` past a limit (checked before the
 * input, an array, a map or a string is allocated), `too-deep`, `malformed`, `unsupported` (see the file's comment)
 */
export function decodeCbor(input: Uint8Array, options?: CborDecodeOptions & { bytes?: false }): JsonValue;
export function decodeCbor(input: Uint8Array, options: CborDecodeOptions): CborValue;
export function decodeCbor(input: Uint8Array, options: CborDecodeOptions = {}): CborValue {
    const limits: CborLimits = { ...DEFAULT_CBOR_LIMITS, ...options.limits };
    const bytes = options.bytes === true;
    if (input.length > limits.maxBytes) throw new CborError("too-large", `the input is longer than ${limits.maxBytes} bytes`);
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    let offset = 0;
    let items = 0;

    const fail = (code: CborErrorCode, reason: string, at = offset): never => {
        throw new CborError(code, `${reason} at byte ${at}`);
    };
    const need = (count: number): void => {
        if (offset + count > input.length) fail("malformed", "the input ends inside a value");
    };
    const count = (more: number): void => {
        items += more;
        if (items > limits.maxItems) fail("too-large", `more than ${limits.maxItems} values`);
    };

    /** The argument of a head whose first byte was read, as a number; past the safe integers is `unsupported` */
    const argument = (info: number, start: number): number => {
        if (info < 24) return info;
        switch (info) {
            case 24:
                need(1);
                return view.getUint8(offset++);
            case 25: {
                need(2);
                const value = view.getUint16(offset);
                offset += 2;
                return value;
            }
            case 26: {
                need(4);
                const value = view.getUint32(offset);
                offset += 4;
                return value;
            }
            case 27: {
                need(8);
                const value = view.getBigUint64(offset);
                offset += 8;
                if (value > BigInt(Number.MAX_SAFE_INTEGER)) fail("unsupported", "an integer or length past 2^53 - 1", start);
                return Number(value);
            }
            case 31:
                return fail("unsupported", "an indefinite length", start);
            default:
                return fail("malformed", "a reserved additional information", start);
        }
    };

    const string = (length: number, start: number): Uint8Array => {
        if (length > limits.maxStringBytes) fail("too-large", `a string longer than ${limits.maxStringBytes} bytes`, start);
        need(length);
        const slice = input.subarray(offset, offset + length);
        offset += length;
        return slice;
    };

    const text = (length: number, start: number): string => {
        const slice = string(length, start);
        // ASCII is read byte by byte, which is faster than a TextDecoder call for short strings
        if (length <= 64) {
            let ascii = "";
            let index = 0;
            for (; index < length; index++) {
                const byte = slice[index] as number;
                if (byte > 0x7f) break;
                ascii += String.fromCharCode(byte);
            }
            if (index === length) return ascii;
        }
        try {
            return utf8Decoder.decode(slice);
        }
        catch {
            return fail("malformed", "invalid UTF-8", start);
        }
    };

    const read = (depth: number): CborValue => {
        const start = offset;
        need(1);
        const initial = view.getUint8(offset++);
        const major = initial >> 5;
        const info = initial & 0x1f;
        count(1);

        if (major === MAJOR_SIMPLE) {
            switch (info) {
                case 20:
                    return false;
                case 21:
                    return true;
                case 22:
                    return null;
                case 25:
                case 26:
                case 27: {
                    let value: number;
                    if (info === 25) {
                        need(2);
                        value = half(view.getUint16(offset));
                        offset += 2;
                    }
                    else if (info === 26) {
                        need(4);
                        value = view.getFloat32(offset);
                        offset += 4;
                    }
                    else {
                        need(8);
                        value = view.getFloat64(offset);
                        offset += 8;
                    }
                    if (!Number.isFinite(value)) fail("unsupported", "NaN or an infinity", start);
                    return value === 0 ? 0 : value;
                }
                case 31:
                    return fail("malformed", "a break outside an indefinite length", start);
                case 28:
                case 29:
                case 30:
                    return fail("malformed", "a reserved additional information", start);
                default:
                    return fail("unsupported", "a simple value other than false, true and null", start);
            }
        }

        const value = argument(info, start);
        switch (major) {
            case MAJOR_UNSIGNED:
                return value;
            case MAJOR_NEGATIVE:
                if (value === Number.MAX_SAFE_INTEGER) fail("unsupported", "an integer past -(2^53 - 1)", start);
                return -1 - value;
            case MAJOR_BYTES:
                if (!bytes) fail("unsupported", "a byte string", start);
                return string(value, start).slice();
            case MAJOR_TEXT:
                return text(value, start);
            case MAJOR_TAG:
                return fail("unsupported", "a tag", start);
            default:
                break;
        }

        if (depth >= limits.maxDepth) fail("too-deep", `nesting deeper than ${limits.maxDepth}`, start);
        if (major === MAJOR_ARRAY) {
            // Every member takes at least a byte, so a count past the bytes left cannot be well formed
            if (value > input.length - offset) fail("malformed", "an array longer than the input", start);
            if (items + value > limits.maxItems) fail("too-large", `more than ${limits.maxItems} values`, start);
            const array: CborValue[] = new Array<CborValue>(value);
            for (let index = 0; index < value; index++) array[index] = read(depth + 1);
            return array;
        }

        // A map: text keys, each once, in the order written
        if (value * 2 > input.length - offset) fail("malformed", "a map longer than the input", start);
        if (items + value * 2 > limits.maxItems) fail("too-large", `more than ${limits.maxItems} values`, start);
        const map: { [key: string]: CborValue } = {};
        for (let index = 0; index < value; index++) {
            const keyAt = offset;
            need(1);
            if (view.getUint8(offset) >> 5 !== MAJOR_TEXT) fail("unsupported", "a map key that is not text", keyAt);
            const key = read(depth + 1) as string;
            if (Object.prototype.hasOwnProperty.call(map, key)) fail("malformed", "a repeated map key", keyAt);
            const member = read(depth + 1);
            // As JSON.parse makes it: an own property, even for "__proto__"
            if (key === "__proto__") Object.defineProperty(map, key, { value: member, enumerable: true, writable: true, configurable: true });
            else map[key] = member;
        }
        return map;
    };

    const result = read(0);
    if (offset !== input.length) fail("malformed", "bytes after the value");
    return result;
}

/**
 * The wire's size and speed, JSON text against CBOR (docs/design/statenet-wire-format.md). It builds a session the way
 * the example app's Northwind data makes one: a welcome whose snapshot holds 300 orders with their lines and customers,
 * then 1,000 `changes` messages of one record change each (a status, a quantity, a new order, a delete). It prints the
 * bytes of each encoding and the time to encode and decode them all, the best of several runs.
 *
 * Run from state-sync after a build: `node scripts/wire-size.ts`
 */
import { decodeCbor, encodeCbor } from "../dist/index.js";
import type { JsonValue } from "../dist/index.js";

type Message = { [key: string]: JsonValue };

/** A seeded generator (mulberry32), so every run measures the same session */
let state = 20261123;
const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
const id = (): string => {
    const hex = Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
};

const CUSTOMERS = ["Alfreds Futterkiste", "Berglunds snabbköp", "Blondel père et fils", "Bon app'", "Ernst Handel", "Folk och fä HB", "Frankenversand", "Lehmanns Marktstand", "QUICK-Stop", "Wartian Herkku"];
const PRODUCTS = ["Chai", "Chang", "Aniseed Syrup", "Ikura", "Konbu", "Tofu", "Pavlova", "Carnarvon Tigers", "Gnocchi di nonna Alice", "Raclette Courdavault"];
const STATUSES = ["new", "picking", "packed", "shipped", "delivered"];

const order = (number: number): JsonValue => {
    const lines: { [key: string]: JsonValue } = {};
    const count = 1 + Math.floor(random() * 5);
    for (let line = 0; line < count; line++) {
        lines[`l${line}`] = { product: pick(PRODUCTS), quantity: 1 + Math.floor(random() * 40), price: Math.round(random() * 9000) / 100, discount: pick([0, 0, 0.05, 0.1, 0.15]) };
    }
    return {
        number: `NW-${10248 + number}`,
        customer: pick(CUSTOMERS),
        status: pick(STATUSES),
        placed: new Date(Date.UTC(2026, 0, 1) + Math.floor(random() * 300) * 86_400_000).toISOString().slice(0, 10),
        freight: Math.round(random() * 20000) / 100,
        rush: random() < 0.1,
        lines
    };
};

const keys: string[] = [];
const orders: { [key: string]: JsonValue } = {};
for (let number = 0; number < 300; number++) {
    const key = `o${number}`;
    keys.push(key);
    orders[key] = order(number);
}

const messages: Message[] = [{ type: "welcome", namespace: "alice.northwind.app", revision: 4812, snapshot: { data: { orders } }, durable: 4812 }];
let revision = 4812;
for (let index = 0; index < 1000; index++) {
    revision++;
    const key = pick(keys);
    const base = revision - 1 - Math.floor(random() * 3);
    const kind = random();
    const change: Message =
        kind < 0.5 ? { id: id(), path: `$.data.orders.${key}.status`, op: "set", value: pick(STATUSES), base, revision }
        : kind < 0.85 ? { id: id(), path: `$.data.orders.${key}.lines.l0.quantity`, op: "set", value: 1 + Math.floor(random() * 40), base, revision }
        : kind < 0.97 ? { id: id(), path: `$.data.orders.o${300 + index}`, op: "set", value: order(300 + index), base, revision }
        : { id: id(), path: `$.data.orders.${key}`, op: "delete", base, revision };
    messages.push({ type: "changes", changes: [change] });
}

const utf8 = new TextEncoder();
const RUNS = 7;

/** The best time over the runs, in ms */
const best = (work: () => void): number => {
    let fastest = Infinity;
    for (let run = 0; run < RUNS; run++) {
        const start = performance.now();
        work();
        fastest = Math.min(fastest, performance.now() - start);
    }
    return fastest;
};

const texts = messages.map((message) => JSON.stringify(message));
const binaries = messages.map((message) => encodeCbor(message));
const sizeOf = (sizes: number[]) => ({ welcome: sizes[0] as number, changes: sizes.slice(1).reduce((sum, size) => sum + size, 0) });
const json = sizeOf(texts.map((text) => utf8.encode(text).length));
const cbor = sizeOf(binaries.map((bytes) => bytes.length));

const timing = {
    jsonEncode: best(() => { for (const message of messages) utf8.encode(JSON.stringify(message)); }),
    jsonDecode: best(() => { for (const text of texts) JSON.parse(text); }),
    cborEncode: best(() => { for (const message of messages) encodeCbor(message); }),
    cborDecode: best(() => { for (const bytes of binaries) decodeCbor(bytes); })
};

const percent = (part: number, whole: number): string => `${Math.round((part / whole) * 100)}%`;
const ms = (value: number): string => `${value.toFixed(1)} ms`;
console.log(`Session: a welcome of 300 orders, then 1,000 changes messages (best of ${RUNS} runs)`);
console.log(`              JSON bytes   CBOR bytes   CBOR/JSON`);
console.log(`welcome     ${String(json.welcome).padStart(12)} ${String(cbor.welcome).padStart(12)}   ${percent(cbor.welcome, json.welcome)}`);
console.log(`changes     ${String(json.changes).padStart(12)} ${String(cbor.changes).padStart(12)}   ${percent(cbor.changes, json.changes)}`);
console.log(`encode      ${ms(timing.jsonEncode).padStart(12)} ${ms(timing.cborEncode).padStart(12)}`);
console.log(`decode      ${ms(timing.jsonDecode).padStart(12)} ${ms(timing.cborDecode).padStart(12)}`);

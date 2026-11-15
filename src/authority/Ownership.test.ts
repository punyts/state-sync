import { describe, expect, it } from "vitest";
import type { Change } from "../Change.js";
import { ClaimPolicy, createMemoryEpochStorage, createMemoryOwnershipStore, OwnerNode } from "./Ownership.js";
import type { NamespaceHost, OwnerNodeOptions, WriteOutcome } from "./Ownership.js";
import { createAuthority } from "./Authority.js";
import type { Authority } from "./Authority.js";
import { createRelay } from "./Relay.js";
import type { RelayListener, Upstream } from "./Relay.js";

const ADDRESS = "alice/notes/user";

let counter = 0;
const change = (path: string, value: unknown): Change => ({ id: `c${++counter}`, path, op: "set", value: value as never, base: 0 });
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Nodes that share one ownership store and one storage, and reach each other while they are up */
const cluster = (clock: () => number = Date.now, extra: Partial<OwnerNodeOptions> = {}) => {
    const ownership = createMemoryOwnershipStore(clock);
    const storage = createMemoryEpochStorage();
    const nodes = new Map<string, OwnerNode>();
    const up = new Set<string>();
    const node = (id: string, options: Partial<OwnerNodeOptions> = {}) => {
        const made = new OwnerNode({ id, ownership, storage, link: (other) => (up.has(other) ? nodes.get(other) : undefined), initial: () => ({ data: { log: {} } }), now: clock, ...extra, ...options });
        nodes.set(id, made);
        up.add(id);
        return made;
    };
    return { ownership, storage, node, down: (id: string) => up.delete(id) };
};

describe("OwnerNode", () => {
    it("should order no change twice and lose none during a handoff, and land the writes sent meanwhile after it, in order", async () => {
        // Arrange
        const { node, ownership } = cluster();
        const a = node("a");
        const b = node("b");
        await a.write(ADDRESS, change("$.data.log.first", 0));

        // Act: writes keep coming through both nodes while b claims the namespace
        const sent: Array<{ via: OwnerNode; change: Change }> = [];
        const outcomes: Array<Promise<WriteOutcome>> = [];
        for (let index = 0; index < 40; index++) {
            const via = index % 2 === 0 ? a : b;
            const one = change(`$.data.log.k${index}`, index);
            sent.push({ via, change: one });
            outcomes.push(via.write(ADDRESS, one));
            if (index === 15) outcomes.push(b.claim(ADDRESS).then(() => ({ result: "rejected", reason: "claim" }) as WriteOutcome));
        }
        const results = await Promise.all(outcomes);
        await tick();

        // Assert
        const applied = results.filter((result): result is Extract<WriteOutcome, { revision: number }> => result.result === "applied");
        const revisions = applied.map((result) => result.revision).sort((x, y) => x - y);
        expect(applied).toHaveLength(40);
        expect(revisions).toEqual(Array.from({ length: 40 }, (_, index) => index + 2));
        expect(b.owned()).toEqual([ADDRESS]);
        expect(a.owned()).toEqual([]);
        expect((await ownership.get(ADDRESS))?.epoch).toBe(2);
        const log = (await b.authorityOf(ADDRESS))?.get("$.data.log") as Record<string, number>;
        expect(Object.keys(log)).toHaveLength(41);
        // each node's writes keep the order they were sent in
        for (const via of [a, b]) {
            const mine = sent.map((item, index) => ({ item, result: results[index + (index > 15 ? 1 : 0)] })).filter(({ item }) => item.via === via);
            const order = mine.map(({ result }) => (result as { revision: number }).revision);
            expect(order).toEqual([...order].sort((x, y) => x - y));
        }
    });

    it("should refuse what an old owner writes after its lease ran out, at the storage and at the relays", async () => {
        // Arrange: a stops renewing (paused), and b takes over once the lease runs out
        let clock = 1_000_000;
        const { node, storage } = cluster(() => clock, { leaseMs: 1000, renewEveryMs: 60_000 });
        const a = node("a");
        const b = node("b");
        await a.write(ADDRESS, change("$.data.log.mine", "a"));
        await (await a.authorityOf(ADDRESS))?.flush();
        clock += 2000;

        // Act
        const taken = await b.write(ADDRESS, change("$.data.log.theirs", "b"));
        await (await b.authorityOf(ADDRESS))?.flush();
        const late = await a.write(ADDRESS, change("$.data.log.late", "a"));
        await (await a.authorityOf(ADDRESS))?.flush();

        // Assert
        expect(taken).toMatchObject({ result: "applied", epoch: 2 });
        expect(late).toMatchObject({ result: "applied", epoch: 1 });
        expect(storage.epochOf(ADDRESS)).toBe(2);
        expect((await storage.load(ADDRESS))?.state).toEqual({ data: { log: { mine: "a", theirs: "b" } } });
    });

    it("should move ownership to a node that sends most writes, and not bounce it between two that write equally", async () => {
        // Arrange
        let clock = 0;
        const owners: string[] = [];
        const policy = () => new ClaimPolicy({ now: () => clock, minWrites: 10, windowMs: 300, cooldownMs: 30_000 });
        const { node } = cluster(Date.now, { onOwner: (_address, owning, epoch) => owning && owners.push(String(epoch)) });
        const a = node("a", { policy: policy() });
        const b = node("b", { policy: policy() });

        // Act: equal writes through both
        for (let index = 0; index < 60; index++) {
            clock += 10;
            await (index % 2 === 0 ? a : b).write(ADDRESS, change(`$.data.log.e${index}`, index));
        }
        await tick();
        const afterEqual = { a: a.owned(), b: b.owned(), moves: owners.length };
        // then nearly all through b
        for (let index = 0; index < 40; index++) {
            clock += 10;
            await (index % 10 === 0 ? a : b).write(ADDRESS, change(`$.data.log.b${index}`, index));
        }
        await tick();

        // Assert
        expect(afterEqual).toEqual({ a: [ADDRESS], b: [], moves: 1 });
        expect(b.owned()).toEqual([ADDRESS]);
        expect(owners).toHaveLength(2);
    });

    it("should take over the namespaces of a node that is gone once their leases run out, and not before", async () => {
        // Arrange
        let clock = 5_000_000;
        const { node, down } = cluster(() => clock, { leaseMs: 1000, renewEveryMs: 60_000 });
        const a = node("a");
        const b = node("b");
        await a.write(ADDRESS, change("$.data.log.one", 1));
        await (await a.authorityOf(ADDRESS))?.flush();
        await a.stop();
        down("a");

        // Act
        const early = await b.write(ADDRESS, change("$.data.log.two", 2));
        clock += 1500;
        const later = await b.write(ADDRESS, change("$.data.log.three", 3));

        // Assert
        expect(early).toEqual({ result: "rejected", reason: `${ADDRESS} is owned by another node` });
        expect(later).toMatchObject({ result: "applied", epoch: 2 });
        expect((await b.authorityOf(ADDRESS))?.get("$.data.log")).toEqual({ one: 1, three: 3 });
    });
});

describe("OwnerNode with a host of its own", () => {
    /** A host whose authorities can be restarted, as an app server restarts an instance over a changed definition */
    const restartingHost = () => {
        const storage = createMemoryEpochStorage();
        const running = new Map<string, Promise<Authority>>();
        const epochs: number[] = [];
        const released: string[] = [];
        const host: NamespaceHost = {
            authority: (address, epoch) => {
                let found = running.get(address);
                if (found === undefined) {
                    epochs.push(epoch);
                    found = createAuthority({ namespace: "n", storage: { load: () => storage.load(address), save: (_namespace, stored) => storage.save(address, stored, epoch) }, initial: { data: {} }, createParents: true });
                    running.set(address, found);
                }
                return found;
            },
            release: async (address) => {
                released.push(address);
                (await running.get(address))?.close();
                running.delete(address);
            }
        };
        const restart = async (address: string) => {
            const authority = await running.get(address);
            await authority?.flush();
            authority?.close();
            running.delete(address);
        };
        return { host, epochs, released, restart };
    };

    it("should order writes on the host's authority under the epoch it took, and again on the one that replaced it", async () => {
        // Arrange
        const ownership = createMemoryOwnershipStore();
        const { host, epochs, restart } = restartingHost();
        const node = new OwnerNode({ id: "a", ownership, host, link: () => undefined });

        // Act
        const first = await node.write(ADDRESS, change("$.data.one", 1));
        await restart(ADDRESS);
        const second = await node.write(ADDRESS, change("$.data.two", 2));

        // Assert
        expect(first).toMatchObject({ result: "applied", epoch: 1 });
        expect(second).toMatchObject({ result: "applied", epoch: 1 });
        expect(epochs).toEqual([1, 1]);
        expect((await node.authorityOf(ADDRESS))?.get("$.data")).toEqual({ one: 1, two: 2 });
        await node.stop();
    });

    it("should release the host's authority when it hands a namespace off, and tell where it is placed", async () => {
        // Arrange
        const ownership = createMemoryOwnershipStore();
        const one = restartingHost();
        const two = restartingHost();
        const nodes = new Map<string, OwnerNode>();
        const a = new OwnerNode({ id: "a", ownership, host: one.host, link: (id) => nodes.get(id) });
        const b = new OwnerNode({ id: "b", ownership, host: two.host, link: (id) => nodes.get(id) });
        nodes.set("a", a).set("b", b);

        // Act
        const first = await a.place(ADDRESS);
        const fromB = await b.place(ADDRESS);
        const claimed = await b.claim(ADDRESS);
        const afterwards = await a.place(ADDRESS);

        // Assert
        expect(first).toEqual({ here: true, epoch: 1 });
        expect(fromB).toEqual({ here: false, node: "a", epoch: 1 });
        expect(claimed).toBe(true);
        expect(one.released).toEqual([ADDRESS]);
        expect(two.epochs).toEqual([2]);
        expect(afterwards).toMatchObject({ here: false, node: "b" });
        await a.stop();
        await b.stop();
    });
});

describe("ClaimPolicy", () => {
    it("should wait out its cooldown after a move", () => {
        let clock = 0;
        const policy = new ClaimPolicy({ now: () => clock, minWrites: 5, cooldownMs: 1000 });
        for (let index = 0; index < 10; index++) policy.record(ADDRESS, "b");
        expect(policy.moveTo(ADDRESS, "a")).toBe("b");
        policy.moved(ADDRESS);
        for (let index = 0; index < 10; index++) policy.record(ADDRESS, "a");
        expect(policy.moveTo(ADDRESS, "b")).toBeUndefined();
        clock = 1500;
        for (let index = 0; index < 10; index++) policy.record(ADDRESS, "a");
        expect(policy.moveTo(ADDRESS, "b")).toBe("a");
    });
});

describe("a relay across owners", () => {
    it("should refuse changes ordered under an older epoch, and start over from a snapshot under a newer one", async () => {
        // Arrange: an upstream whose batches the test sends by hand
        let feed!: RelayListener;
        let subscriptions = 0;
        let epoch = 2;
        const upstream: Upstream = {
            subscribe: (_address, _prefix, _revision, listener) => {
                subscriptions++;
                feed = listener;
                queueMicrotask(() => listener.welcome({ revision: 5, value: { a: 1 }, epoch }));
                return { renew: () => undefined, close: () => undefined };
            }
        };
        const relay = createRelay(upstream, { sweep: false });
        const seen: unknown[] = [];
        relay.subscribe(ADDRESS, "$.data", undefined, { welcome: (welcome) => seen.push(welcome), changes: (batch) => seen.push(batch) });
        await tick();

        // Act
        feed.changes({ previous: 5, revision: 6, changes: [{ id: "old", path: "$.data.b", op: "set", value: 1, base: 0, revision: 6 }], epoch: 1 });
        feed.changes({ previous: 5, revision: 6, changes: [{ id: "new", path: "$.data.c", op: "set", value: 1, base: 0, revision: 6 }], epoch: 2 });
        epoch = 3;
        feed.changes({ previous: 6, revision: 6, changes: [], epoch: 3 });
        await tick();

        // Assert
        expect(seen.map((item) => ("changes" in (item as object) ? (item as { changes: Array<{ id: string }> }).changes.map((each) => each.id) : "welcome"))).toEqual(["welcome", ["new"], "welcome"]);
        expect(subscriptions).toBe(2);
    });
});

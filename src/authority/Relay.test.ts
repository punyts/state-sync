import { describe, expect, it } from "vitest";
import type { JsonValue, RevisedChange } from "../Change.js";
import { createAuthority } from "./Authority.js";
import { createMemoryNamespaceStorage } from "./NamespaceStorage.js";
import { createAuthorityUpstream, createRelay, projectChange } from "./Relay.js";
import type { RelayBatch, RelayListener, RelayWelcome, Upstream } from "./Relay.js";

const ADDRESS = "owner/app/app";

const owner = async () => {
    const authority = await createAuthority({ namespace: "owner.app", storage: createMemoryNamespaceStorage(), initial: { data: { orders: { o1: { total: 5 } }, other: 1 } } });
    const upstream = createAuthorityUpstream(async (address) => (address === ADDRESS ? authority : undefined));
    let subscriptions = 0;
    let open = 0;
    const counting: Upstream = {
        subscribe: (address, prefix, revision, listener) => {
            subscriptions++;
            open++;
            const inner = upstream.subscribe(address, prefix, revision, listener);
            return { renew: inner.renew, close: () => {
                open--;
                inner.close();
            } };
        }
    };
    return { authority, upstream: counting, subscriptions: () => subscriptions, open: () => open };
};

/** A listener that keeps the value under its prefix from what it is sent, and checks it never misses or repeats */
const follower = (prefix: string) => {
    const seen: number[] = [];
    const state: { value: JsonValue | undefined; revision: number; gaps: number; closed?: string; welcomes: RelayWelcome[] } = { value: undefined, revision: 0, gaps: 0, welcomes: [] };
    const apply = (change: RevisedChange) => {
        const rest = change.path === prefix ? [] : change.path.slice(prefix.length + 1).split(".");
        if (rest.length === 0) {
            state.value = change.op === "delete" ? undefined : structuredClone(change.value);
            return;
        }
        let node = (state.value ??= {}) as { [key: string]: JsonValue };
        for (const step of rest.slice(0, -1)) node = (node[step] ??= {}) as { [key: string]: JsonValue };
        const last = rest[rest.length - 1] as string;
        if (change.op === "delete") delete node[last];
        else node[last] = structuredClone(change.value as JsonValue);
    };
    const listener: RelayListener = {
        welcome: (welcome) => {
            state.welcomes.push(welcome);
            if ("value" in welcome) state.value = structuredClone(welcome.value);
            else for (const change of welcome.changes) {
                seen.push(change.revision);
                apply(change);
            }
            state.revision = welcome.revision;
        },
        changes: (batch: RelayBatch) => {
            if (batch.previous !== state.revision) state.gaps++;
            for (const change of batch.changes) {
                seen.push(change.revision);
                apply(change);
            }
            state.revision = batch.revision;
        },
        closed: (reason) => (state.closed = reason)
    };
    return { listener, state, seen };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("projectChange", () => {
    it("should keep a change at or below the prefix, project one above it, and leave out one beside it", () => {
        const change = (path: string, op: RevisedChange["op"], value?: JsonValue): RevisedChange => ({ id: "c", path, op, base: 0, revision: 3, ...(value === undefined ? {} : { value }) });

        expect(projectChange(change("$.data.orders.o1.total", "set", 6), "$.data.orders")?.path).toBe("$.data.orders.o1.total");
        expect(projectChange(change("$.data", "set", { orders: { o2: {} } }), "$.data.orders")).toMatchObject({ path: "$.data.orders", op: "set", value: { o2: {} } });
        expect(projectChange(change("$.data", "set", { other: 1 }), "$.data.orders")).toMatchObject({ path: "$.data.orders", op: "delete" });
        expect(projectChange(change("$.data", "merge", { other: 2 }), "$.data.orders")).toBeUndefined();
        expect(projectChange(change("$.data.other", "set", 2), "$.data.orders")).toBeUndefined();
    });
});

describe("createRelay", () => {
    it("should make one upstream subscription for a thousand listeners of one path, and give each of them every change", async () => {
        // Arrange
        const node = await owner();
        const relay = createRelay(node.upstream, { sweep: false });
        const followers = Array.from({ length: 1000 }, () => follower("$.data.orders"));

        // Act
        for (const one of followers) relay.subscribe(ADDRESS, "$.data.orders", 0, one.listener);
        await tick();
        node.authority.write({ path: "$.data.orders.o2", op: "set", value: { total: 9 } });
        node.authority.write({ path: "$.data.other", op: "set", value: 2 });

        // Assert
        expect(node.subscriptions()).toBe(1);
        expect(relay.stats()).toEqual({ upstream: 1, listeners: 1000 });
        expect(followers.every((one) => JSON.stringify(one.state.value) === JSON.stringify(node.authority.get("$.data.orders")))).toBe(true);
        expect(followers.every((one) => one.state.gaps === 0 && one.state.revision === 1)).toBe(true);
    });

    it("should drop a listener that stops renewing, and the upstream subscription only it needed", async () => {
        // Arrange
        let clock = 0;
        const node = await owner();
        const relay = createRelay(node.upstream, { sweep: false, leaseMs: 1000, now: () => clock });
        const quiet = follower("$.data.other");
        const busy = follower("$.data.orders");
        relay.subscribe(ADDRESS, "$.data.other", 0, quiet.listener);
        const kept = relay.subscribe(ADDRESS, "$.data.orders", 0, busy.listener);
        await tick();

        // Act
        clock = 800;
        kept.renew();
        clock = 1200;
        relay.sweep();

        // Assert
        expect(quiet.state.closed).toBe("the lease ran out");
        expect(busy.state.closed).toBeUndefined();
        expect(relay.stats()).toEqual({ upstream: 1, listeners: 1 });
        expect(node.open()).toBe(1);
    });

    it("should catch a listener up from its revision from the cache, never missing or repeating a change", async () => {
        // Arrange
        const node = await owner();
        const relay = createRelay(node.upstream, { sweep: false });
        const first = follower("$.data.orders");
        const one = relay.subscribe(ADDRESS, "$.data.orders", 0, first.listener);
        await tick();
        node.authority.write({ path: "$.data.orders.o1.total", op: "set", value: 6 });
        one.close();
        const keeper = relay.subscribe(ADDRESS, "$.data.orders", 0, follower("$.data.orders").listener);
        await tick();

        // Act: changes while the first listener is away, then it comes back with the revision it had
        node.authority.write({ path: "$.data.orders.o1.total", op: "set", value: 7 });
        node.authority.write({ path: "$.data.orders.o3", op: "set", value: { total: 1 } });
        relay.subscribe(ADDRESS, "$.data.orders", first.state.revision, first.listener);
        node.authority.write({ path: "$.data.orders.o3.total", op: "set", value: 2 });

        // Assert
        expect(first.seen).toEqual([1, 2, 3, 4]);
        expect(first.state.gaps).toBe(0);
        expect(first.state.value).toEqual(node.authority.get("$.data.orders"));
        keeper.close();
    });

    it("should subscribe again from its own revision when upstream skips a batch, so its listeners miss nothing", async () => {
        // Arrange: an upstream that loses one batch on the way
        const node = await owner();
        let lose = false;
        let resubscribed = 0;
        const lossy: Upstream = {
            subscribe: (address, prefix, revision, listener) => {
                if (revision !== undefined) resubscribed++;
                return node.upstream.subscribe(address, prefix, revision, { ...listener, changes: (batch) => {
                    if (lose) {
                        lose = false;
                        return;
                    }
                    listener.changes(batch);
                } });
            }
        };
        const relay = createRelay(lossy, { sweep: false });
        const one = follower("$.data.orders");
        relay.subscribe(ADDRESS, "$.data.orders", 0, one.listener);
        await tick();

        // Act
        lose = true;
        node.authority.write({ path: "$.data.orders.o1.total", op: "set", value: 6 });
        node.authority.write({ path: "$.data.orders.o1.total", op: "set", value: 7 });
        await tick();

        // Assert
        expect(resubscribed).toBe(1);
        expect(one.seen).toEqual([1, 2]);
        expect(one.state.gaps).toBe(0);
        expect(one.state.value).toEqual({ o1: { total: 7 } });
    });

    it("should pass on the durable watermark, and close the listeners of an address with no namespace", async () => {
        // Arrange
        const node = await owner();
        const relay = createRelay(node.upstream, { sweep: false });
        const durable: number[] = [];
        const nobody = follower("$.data");
        relay.subscribe(ADDRESS, "$.data.orders", 0, { ...follower("$.data.orders").listener, durable: (revision) => durable.push(revision) });
        relay.subscribe("nobody/app/app", "$.data", 0, nobody.listener);
        await tick();

        // Act
        node.authority.write({ path: "$.data.orders.o1.total", op: "set", value: 6 });
        await node.authority.flush();
        await tick();

        // Assert
        expect(durable).toEqual([1]);
        expect(nobody.state.closed).toBe("no namespace at nobody/app/app");
        expect(relay.stats().upstream).toBe(1);
    });
});

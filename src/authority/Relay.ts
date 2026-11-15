import { copyJson } from "../Apply.js";
import type { JsonValue, RevisedChange } from "../Change.js";
import type { Authority } from "./Authority.js";

/**
 * How a listener starts: the value under its prefix at a revision (a snapshot; undefined when nothing is there), or the
 * changes under its prefix since the revision it had, `previous`
 */
export type RelayWelcome =
    | { readonly revision: number; readonly value: JsonValue | undefined; readonly durable?: number }
    | { readonly revision: number; readonly previous: number; readonly changes: readonly RevisedChange[]; readonly durable?: number };

/**
 * Changes under a listener's prefix, already projected onto it (a change above the prefix comes as the part it writes
 * at the prefix). `previous` is the revision the listener must be at: anything else is a gap, and it catches up
 */
export interface RelayBatch {
    readonly previous: number;
    readonly revision: number;
    readonly changes: readonly RevisedChange[];
}

/** What a subscription delivers, in order: one welcome, then batches and watermarks, until it is closed */
export interface RelayListener {
    welcome(welcome: RelayWelcome): void;
    changes(batch: RelayBatch): void;
    durable?(revision: number): void;
    /** The subscription ended from upstream: its lease ran out, or the address has no namespace */
    closed?(reason: string): void;
}

export interface RelaySubscription {
    /** Renews the lease (a relay's own subscriptions to its upstream need no renewing) */
    renew(): void;
    close(): void;
}

/** Where a relay gets the namespaces it serves: an owner node, or a relay nearer to one */
export interface Upstream {
    /** `revision`: the one the subscriber has, to catch up from; undefined when it has nothing and wants a snapshot */
    subscribe(address: string, prefix: string, revision: number | undefined, listener: RelayListener): RelaySubscription;
}

const segmentsOf = (path: string): string[] => (path === "$" ? [] : path.slice(2).split("."));
const isObject = (value: unknown): value is { [key: string]: JsonValue } => typeof value === "object" && value !== null && !Array.isArray(value);
const dig = (value: JsonValue | undefined, steps: readonly string[]): JsonValue | undefined => {
    let current = value;
    for (const step of steps) {
        if (!isObject(current)) {
            return undefined;
        }
        current = current[step];
    }
    return current;
};

/**
 * A change as it writes under a prefix: as it is when it is at or below the prefix, as the set or delete of the
 * prefix when it is above it, undefined when it does not touch the prefix
 */
export const projectChange = (change: RevisedChange, prefix: string): RevisedChange | undefined => {
    const path = segmentsOf(change.path);
    const under = segmentsOf(prefix);
    const shared = Math.min(path.length, under.length);
    for (let index = 0; index < shared; index++) {
        if (path[index] !== under[index]) {
            return undefined;
        }
    }
    if (path.length >= under.length) {
        return change;
    }
    const rest = under.slice(path.length);
    const base = { id: change.id, path: prefix, base: change.base, revision: change.revision, ...(change.ephemeral === true ? { ephemeral: true as const } : {}) };
    if (change.op === "delete") {
        return { ...base, op: "delete" };
    }
    if (change.op === "merge") {
        //a merge writes its keys whole: it touches the prefix only when it has the key on the way to it
        if (!isObject(change.value) || !Object.hasOwn(change.value, rest[0] as string)) {
            return undefined;
        }
    }
    const value = dig(change.value, rest);
    return value === undefined ? { ...base, op: "delete" } : { ...base, op: "set", value: copyJson(value) };
};

/** Applies a projected change to a plain tree, creating parents */
const applyTo = (root: { [key: string]: JsonValue }, change: RevisedChange): void => {
    const steps = segmentsOf(change.path);
    if (steps.length === 0) {
        return;
    }
    let node: { [key: string]: JsonValue } = root;
    for (const step of steps.slice(0, -1)) {
        if (!isObject(node[step])) {
            node[step] = {};
        }
        node = node[step] as { [key: string]: JsonValue };
    }
    const last = steps[steps.length - 1] as string;
    if (change.op === "delete") {
        delete node[last];
    }
    else if (change.op === "merge" && isObject(node[last]) && isObject(change.value)) {
        Object.assign(node[last] as object, copyJson(change.value));
    }
    else if (change.op === "replace" || change.op === "set" || change.op === "merge") {
        node[last] = copyJson(change.value as JsonValue);
    }
};

/**
 * The owner node's side of subscriptions: serves the namespaces of its authorities by address, each subscription the
 * changes under its prefix. A subscription with a revision the authority's log still reaches gets the changes since;
 * any other a snapshot of the prefix
 */
export const createAuthorityUpstream = (resolve: (address: string) => Promise<Authority | undefined>): Upstream => ({
    subscribe: (address, prefix, revision, listener) => {
        let closed = false;
        const removers: (() => void)[] = [];
        resolve(address).then((authority) => {
            if (closed) {
                return;
            }
            if (authority === undefined) {
                listener.closed?.(`no namespace at ${address}`);
                return;
            }
            let last = authority.revision();
            const since = revision === undefined ? undefined : authority.changesSince(revision);
            const durable = { durable: authority.durable() };
            listener.welcome(since === undefined
                ? { revision: last, value: authority.get(prefix), ...durable }
                : { revision: last, previous: revision as number, changes: since.map((change) => projectChange(change, prefix)).filter((change) => change !== undefined), ...durable });
            removers.push(authority.onChanges((changes) => {
                const projected = changes.map((change) => projectChange(change, prefix)).filter((change) => change !== undefined);
                const to = (changes[changes.length - 1] as RevisedChange).revision;
                if (projected.length === 0) {
                    //nothing under the prefix: the listener's revision stays where it is
                    return;
                }
                listener.changes({ previous: last, revision: to, changes: projected });
                last = to;
            }));
            removers.push(authority.onDurable((to) => listener.durable?.(to)));
        }, (error: unknown) => listener.closed?.(error instanceof Error ? error.message : String(error)));
        return {
            renew: () => undefined,
            close: () => {
                closed = true;
                for (const remove of removers.splice(0)) {
                    remove();
                }
            }
        };
    }
});

export interface RelayOptions {
    /** How long a subscription lives without a renewal; 30 seconds by default */
    leaseMs?: number;
    /** The most changes kept per subscribed prefix for catching listeners up; 1000 by default */
    logLength?: number;
    /** The clock, for tests */
    now?: () => number;
    /** Sweeps out lapsed subscriptions on a timer (half the lease); true by default */
    sweep?: boolean;
}

interface Listening {
    readonly listener: RelayListener;
    /** The revision this listener has: what its next batch must follow */
    revision: number;
    expires: number;
    /** Waiting for the entry's first welcome, with the revision it asked from */
    waiting?: number;
}

interface Entry {
    readonly address: string;
    readonly prefix: string;
    upstream: RelaySubscription | undefined;
    ready: boolean;
    revision: number;
    durable: number;
    /** The cached tree: only the prefix's subtree, at its real path */
    readonly root: { [key: string]: JsonValue };
    /** The projected changes since `logFrom`, oldest first */
    log: RevisedChange[];
    logFrom: number;
    readonly listeners: Set<Listening>;
}

/** What a relay tells about itself, for tests and its owner */
export interface RelayStats {
    /** Subscriptions it holds upstream, one per address and prefix that has listeners */
    upstream: number;
    /** Listeners below it */
    listeners: number;
}

export interface Relay extends Upstream {
    /** Drops the listeners whose lease ran out, and the upstream subscriptions only they needed */
    sweep: () => void;
    stats: () => RelayStats;
    /** Closes every subscription, upstream and below */
    close: () => void;
}

/**
 * A relay (docs/design/statenet-relays.md, "Relays and subscriptions"): it subscribes upstream once per address and
 * prefix, however many listeners below asked, caches the prefix with its revision and recent changes, and serves each
 * listener from the cache: the changes since its revision while the cache's log reaches back to it, a snapshot
 * otherwise. Subscriptions are leases: a listener that stops renewing is dropped, and when a prefix has no listeners
 * left its upstream subscription is closed. A gap in what comes from upstream makes the relay subscribe again from its
 * own revision, so a listener never misses or repeats a change
 */
export const createRelay = (upstream: Upstream, options: RelayOptions = {}): Relay => {
    const leaseMs = options.leaseMs ?? 30_000;
    const logLength = Math.max(1, options.logLength ?? 1000);
    const now = options.now ?? Date.now;
    const entries = new Map<string, Entry>();
    let timer: ReturnType<typeof setInterval> | undefined;

    const keyOf = (address: string, prefix: string) => `${address}\n${prefix}`;

    const serve = (entry: Entry, listening: Listening, from: number) => {
        const durable = { durable: entry.durable };
        if (from === entry.revision && from > 0) {
            listening.listener.welcome({ revision: entry.revision, previous: from, changes: [], ...durable });
        }
        else if (from > 0 && from >= entry.logFrom && from < entry.revision) {
            listening.listener.welcome({ revision: entry.revision, previous: from, changes: copyJson(entry.log.filter((change) => change.revision > from)), ...durable });
        }
        else {
            const value = dig(entry.root, segmentsOf(entry.prefix));
            listening.listener.welcome({ revision: entry.revision, value: value === undefined ? undefined : copyJson(value), ...durable });
        }
        listening.revision = entry.revision;
    };

    const open = (entry: Entry) => {
        entry.upstream = upstream.subscribe(entry.address, entry.prefix, entry.ready ? entry.revision : undefined, {
            welcome: (welcome) => {
                if ("value" in welcome) {
                    //a snapshot: the cache starts over at its revision
                    for (const key of Object.keys(entry.root)) {
                        delete entry.root[key];
                    }
                    if (welcome.value !== undefined) {
                        applyTo(entry.root, { id: "snapshot", path: entry.prefix, op: "set", value: welcome.value, base: 0, revision: welcome.revision });
                    }
                    const caughtUp = entry.ready;
                    entry.revision = welcome.revision;
                    entry.log = [];
                    entry.logFrom = welcome.revision;
                    entry.ready = true;
                    for (const listening of entry.listeners) {
                        //a listener served before the gap gets the snapshot again, as a new welcome
                        if (listening.waiting !== undefined || caughtUp) {
                            const from = listening.waiting ?? listening.revision;
                            delete listening.waiting;
                            serve(entry, listening, from === welcome.revision ? from : 0);
                        }
                    }
                }
                else {
                    accept(entry, { previous: welcome.previous, revision: welcome.revision, changes: welcome.changes }, true);
                    entry.ready = true;
                    for (const listening of entry.listeners) {
                        if (listening.waiting !== undefined) {
                            const from = listening.waiting;
                            delete listening.waiting;
                            serve(entry, listening, from);
                        }
                    }
                }
                if (welcome.durable !== undefined) {
                    durableOf(entry, welcome.durable);
                }
            },
            changes: (batch) => accept(entry, batch, false),
            durable: (revision) => durableOf(entry, revision),
            closed: (reason) => {
                for (const listening of entry.listeners) {
                    listening.listener.closed?.(reason);
                }
                entry.listeners.clear();
                drop(entry);
            }
        });
    };

    /** Takes changes from upstream into the cache and passes them on; a gap subscribes again from the cache's revision */
    const accept = (entry: Entry, batch: RelayBatch, catchingUp: boolean) => {
        if (batch.previous !== entry.revision && !(catchingUp && batch.previous <= entry.revision)) {
            entry.upstream?.close();
            open(entry);
            return;
        }
        const fresh = batch.changes.filter((change) => change.revision > entry.revision);
        if (fresh.length === 0 && batch.revision <= entry.revision) {
            return;
        }
        for (const change of fresh) {
            applyTo(entry.root, change);
            entry.log.push(copyJson(change));
        }
        if (entry.log.length > logLength) {
            const dropped = entry.log.splice(0, entry.log.length - logLength);
            entry.logFrom = (dropped[dropped.length - 1] as RevisedChange).revision;
        }
        entry.revision = batch.revision;
        if (fresh.length === 0) {
            return;
        }
        for (const listening of entry.listeners) {
            if (listening.waiting !== undefined) {
                continue;
            }
            listening.listener.changes({ previous: listening.revision, revision: entry.revision, changes: copyJson(fresh.filter((change) => change.revision > listening.revision)) });
            listening.revision = entry.revision;
        }
    };

    const durableOf = (entry: Entry, revision: number) => {
        if (revision <= entry.durable) {
            return;
        }
        entry.durable = revision;
        for (const listening of entry.listeners) {
            if (listening.waiting === undefined) {
                listening.listener.durable?.(revision);
            }
        }
    };

    const drop = (entry: Entry) => {
        entry.upstream?.close();
        entry.upstream = undefined;
        entries.delete(keyOf(entry.address, entry.prefix));
        if (entries.size === 0 && timer !== undefined) {
            clearInterval(timer);
            timer = undefined;
        }
    };

    const sweep = () => {
        const at = now();
        for (const entry of [...entries.values()]) {
            for (const listening of [...entry.listeners]) {
                if (listening.expires <= at) {
                    entry.listeners.delete(listening);
                    listening.listener.closed?.("the lease ran out");
                }
            }
            if (entry.listeners.size === 0) {
                drop(entry);
            }
        }
    };

    return {
        subscribe: (address, prefix, asked, listener) => {
            //a listener with nothing (no revision, or 0) gets a snapshot
            const revision = asked ?? 0;
            const key = keyOf(address, prefix);
            let entry = entries.get(key);
            const listening: Listening = { listener, revision, expires: now() + leaseMs };
            if (entry === undefined) {
                entry = { address, prefix, upstream: undefined, ready: false, revision: 0, durable: 0, root: {}, log: [], logFrom: 0, listeners: new Set() };
                entries.set(key, entry);
                entry.listeners.add({ ...listening, waiting: revision });
                const added = [...entry.listeners][0] as Listening;
                open(entry);
                if (options.sweep !== false && timer === undefined) {
                    timer = setInterval(sweep, Math.max(10, leaseMs / 2));
                    (timer as { unref?: () => void }).unref?.();
                }
                return subscription(entry, added);
            }
            entry.listeners.add(listening);
            if (entry.ready) {
                serve(entry, listening, revision);
            }
            else {
                listening.waiting = revision;
            }
            return subscription(entry, listening);
        },
        sweep,
        stats: () => ({ upstream: [...entries.values()].filter((entry) => entry.upstream !== undefined).length, listeners: [...entries.values()].reduce((sum, entry) => sum + entry.listeners.size, 0) }),
        close: () => {
            for (const entry of [...entries.values()]) {
                entry.listeners.clear();
                drop(entry);
            }
        }
    };

    function subscription(entry: Entry, listening: Listening): RelaySubscription {
        return {
            renew: () => {
                listening.expires = now() + leaseMs;
            },
            close: () => {
                entry.listeners.delete(listening);
                if (entry.listeners.size === 0 && entries.get(keyOf(entry.address, entry.prefix)) === entry) {
                    drop(entry);
                }
            }
        };
    }
};

import { isReported, report } from "@punyts/core";
import { copyJson } from "../Apply.js";
import type { JsonValue, RevisedChange } from "../Change.js";
import { SERVER_PATH, isAtOrBelow } from "../Paths.js";
import type { Authority } from "./Authority.js";
import { checkAccess, RevocationList, type Access, type GrantKey } from "./Grants.js";

/**
 * How a listener starts: the value under its prefix at a revision (a snapshot; undefined when nothing is there), or the
 * changes under its prefix since the revision it had, `previous`
 */
export type RelayWelcome =
    | { readonly revision: number; readonly value: JsonValue | undefined; readonly durable?: number; readonly epoch?: number }
    | { readonly revision: number; readonly previous: number; readonly changes: readonly RevisedChange[]; readonly durable?: number; readonly epoch?: number };

/**
 * Changes under a listener's prefix, already projected onto it (a change above the prefix comes as the part it writes
 * at the prefix). `previous` is the revision the listener must be at: anything else is a gap, and it catches up
 */
export interface RelayBatch {
    readonly previous: number;
    readonly revision: number;
    readonly changes: readonly RevisedChange[];
    /** The epoch of the owner that ordered them: a relay refuses an older one than it has seen */
    readonly epoch?: number;
}

/** What a subscription delivers, in order: one welcome, then batches and watermarks, until it is closed */
export interface RelayListener {
    welcome(welcome: RelayWelcome): void;
    changes(batch: RelayBatch): void;
    durable?(revision: number): void;
    /** The subscription ended: its lease ran out, its grant was refused or revoked, or the address has no namespace */
    closed?(reason: string): void;
    /** A grant was revoked: passed down every subscription, so relays below drop the listeners that used it */
    revoked?(grantId: string, expires: number): void;
}

export interface RelaySubscription {
    /** Renews the lease (a relay's own subscriptions to its upstream need no renewing) */
    renew(): void;
    close(): void;
}

/** Where a relay gets the namespaces it serves: an owner node, or a relay nearer to one */
export interface Upstream {
    /**
     * `revision`: the one the subscriber has, to catch up from; undefined when it has nothing and wants a snapshot.
     * `access`: who subscribes and the grant they present, which the first relay checks
     */
    subscribe(address: string, prefix: string, revision: number | undefined, listener: RelayListener, access?: Access): RelaySubscription;
}

/** The category of a relay's reports: addresses, prefixes, revisions, epochs and counts, never values */
const CATEGORY = "state-sync.relay";

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
        //a change of the whole namespace: the tree becomes its value
        if (change.op !== "merge") {
            for (const key of Object.keys(root)) {
                delete root[key];
            }
        }
        if (change.op !== "delete" && isObject(change.value)) {
            Object.assign(root, copyJson(change.value));
        }
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
/** A copy of the root without $.server */
const withoutServer = (value: { [key: string]: JsonValue }): { [key: string]: JsonValue } => {
    const { server: _server, ...rest } = value;
    return rest;
};

export const createAuthorityUpstream = (resolve: (address: string) => Promise<Authority | undefined>, epochOf?: (address: string) => number | undefined): Upstream => ({
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
            if (isAtOrBelow(prefix, SERVER_PATH)) {
                listener.closed?.("$.server is never served");
                return;
            }
            let last = authority.revision();
            const since = revision === undefined ? undefined : authority.changesSince(revision);
            const epoch = epochOf?.(address);
            const durable = { durable: authority.durable(), ...(epoch === undefined ? {} : { epoch }) };
            // $.server stays with the owner: it is never in a snapshot or a change that leaves it
            const project = (list: readonly RevisedChange[]): RevisedChange[] => list.filter((change) => !isAtOrBelow(change.path, SERVER_PATH)).map((change) => projectChange(change, prefix)).filter((change) => change !== undefined);
            const value = authority.get(prefix);
            listener.welcome(since === undefined
                ? { revision: last, value: prefix === "$" && isObject(value) ? withoutServer(value) : value, ...durable }
                : { revision: last, previous: revision as number, changes: project(since), ...durable });
            removers.push(authority.onClose(() => {
                if (!closed) {
                    closed = true;
                    listener.closed?.("the namespace's authority closed");
                }
            }));
            removers.push(authority.onChanges((changes) => {
                const projected = project(changes);
                const to = (changes[changes.length - 1] as RevisedChange).revision;
                if (projected.length === 0) {
                    //nothing under the prefix: the listener's revision stays where it is
                    return;
                }
                listener.changes({ previous: last, revision: to, changes: projected, ...(epoch === undefined ? {} : { epoch }) });
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
    /**
     * Checks every subscription's read access on subscribe and on each renewal (the owner of an address reads freely,
     * anyone else with a read grant for the prefix): the public keys by id. Without it every subscription is served
     */
    grants?: { keyOf: (kid: string) => GrantKey | undefined };
    /** This relay's node id, which it presents upstream: the relay above trusts it rather than asking for grants */
    node?: string;
    /** The nodes below whose subscriptions are served without a grant: their own first relay checked their listeners */
    trustedNodes?: (subject: string) => boolean;
}

interface Listening {
    readonly listener: RelayListener;
    readonly access?: Access;
    /** The grant ids its read rests on, and when that read lapses */
    chain: readonly string[];
    readEnds: number;
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
    /** The newest owner epoch seen: changes from an older one are refused */
    epoch: number;
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
    /** Drops the listeners whose lease or read ran out, and the upstream subscriptions only they needed */
    sweep: () => void;
    /**
     * Revokes a grant here and below: the listeners whose read rests on it (or on a grant it was passed on from) are
     * closed, every listener is told so relays below do the same, and the id is kept until `expires`, so a renewal or
     * a new subscription with it fails
     */
    revoke: (grantId: string, expires: number) => void;
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
    const revocations = new RevocationList();

    /** Whether an access may read a prefix of an address, and on what grants; everyone may without `grants` */
    const readable = (address: string, prefix: string, access: Access | undefined) =>
        options.grants === undefined || (access !== undefined && options.trustedNodes?.(access.subject) === true)
            ? { ok: true as const, expires: Number.POSITIVE_INFINITY, chain: [] as readonly string[] }
            : checkAccess(access, { address, path: prefix, right: "read" }, { keyOf: options.grants.keyOf, now: now(), revoked: (id) => revocations.has(id) });

    /** Closes one listener with a reason, and the entry's upstream subscription when it was the last */
    const remove = (entry: Entry, listening: Listening, reason: string) => {
        report(CATEGORY, "Closed a listener of %s %s: %s", [entry.address, entry.prefix, reason]);
        entry.listeners.delete(listening);
        listening.listener.closed?.(reason);
        if (entry.listeners.size === 0 && entries.get(keyOf(entry.address, entry.prefix)) === entry) {
            drop(entry);
        }
    };

    const revoke = (grantId: string, expires: number) => {
        report(CATEGORY, "Grant %s was revoked", [grantId]);
        revocations.add(grantId, expires);
        for (const entry of [...entries.values()]) {
            for (const listening of [...entry.listeners]) {
                if (listening.chain.includes(grantId)) {
                    remove(entry, listening, "revoked");
                }
                else {
                    listening.listener.revoked?.(grantId, expires);
                }
            }
        }
    };

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

    /** Subscribes upstream from the cache's revision, or for a snapshot when it has none or must start over (`fresh`) */
    const open = (entry: Entry, fresh = false) => {
        report(CATEGORY, "Subscribing upstream to %s %s %s", [entry.address, entry.prefix, entry.ready && !fresh ? `from revision ${entry.revision}` : "for a snapshot"]);
        entry.upstream = upstream.subscribe(entry.address, entry.prefix, entry.ready && !fresh ? entry.revision : undefined, {
            welcome: (welcome) => {
                if (welcome.epoch !== undefined) {
                    if (welcome.epoch < entry.epoch) {
                        report(CATEGORY, "Refused a welcome of %s under epoch %s, older than %s", [entry.address, welcome.epoch, entry.epoch]);
                        return;
                    }
                    entry.epoch = welcome.epoch;
                }
                report(CATEGORY, "Upstream welcomed %s %s at revision %s with %s, %s listeners", [entry.address, entry.prefix, welcome.revision, "value" in welcome ? "a snapshot" : `${welcome.changes.length} changes`, entry.listeners.size]);
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
            revoked: (grantId, expires) => revoke(grantId, expires),
            closed: (reason) => {
                report(CATEGORY, "Upstream closed %s %s: %s, %s listeners", [entry.address, entry.prefix, reason, entry.listeners.size]);
                for (const listening of entry.listeners) {
                    listening.listener.closed?.(reason);
                }
                entry.listeners.clear();
                drop(entry);
            }
        }, options.node === undefined ? undefined : { subject: options.node });
    };

    /** Takes changes from upstream into the cache and passes them on; a gap subscribes again from the cache's revision */
    const accept = (entry: Entry, batch: RelayBatch, catchingUp: boolean) => {
        if (batch.epoch !== undefined && batch.epoch !== entry.epoch) {
            if (batch.epoch < entry.epoch) {
                //an owner that lost ownership: what it ordered is refused
                report(CATEGORY, "Refused changes of %s under epoch %s, older than %s", [entry.address, batch.epoch, entry.epoch]);
                return;
            }
            report(CATEGORY, "A new owner of %s under epoch %s: starting over from a snapshot", [entry.address, batch.epoch]);
            //a new owner started from the durable revision: what the old one ordered past it is gone, so start over
            entry.epoch = batch.epoch;
            entry.upstream?.close();
            open(entry, true);
            return;
        }
        if (batch.previous !== entry.revision && !(catchingUp && batch.previous <= entry.revision)) {
            report(CATEGORY, "Revision gap in %s %s: changes after %s at %s, subscribing again", [entry.address, entry.prefix, batch.previous, entry.revision]);
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
        if (isReported(CATEGORY)) {
            report(CATEGORY, "Passing %s changes of %s %s to %s listeners: %s", [fresh.length, entry.address, entry.prefix, entry.listeners.size, fresh.map((change) => `${change.path}@${change.revision}`).join(", ")]);
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
        report(CATEGORY, "Dropped %s %s: no listeners", [entry.address, entry.prefix]);
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
        revocations.prune(at);
        for (const entry of [...entries.values()]) {
            for (const listening of [...entry.listeners]) {
                if (listening.expires <= at) {
                    report(CATEGORY, "The lease of a listener of %s %s ran out", [entry.address, entry.prefix]);
                    entry.listeners.delete(listening);
                    listening.listener.closed?.("the lease ran out");
                }
                else if (listening.readEnds <= at) {
                    report(CATEGORY, "The grant of a listener of %s %s expired", [entry.address, entry.prefix]);
                    entry.listeners.delete(listening);
                    listening.listener.closed?.("the grant expired");
                }
            }
            if (entry.listeners.size === 0) {
                drop(entry);
            }
        }
    };

    return {
        subscribe: (address, prefix, asked, listener, access) => {
            //a listener with nothing (no revision, or 0) gets a snapshot
            const revision = asked ?? 0;
            const allowed = readable(address, prefix, access);
            if (!allowed.ok) {
                //refused at the first relay: nothing is subscribed upstream
                report(CATEGORY, "Refused a subscription to %s %s: %s", [address, prefix, allowed.reason]);
                queueMicrotask(() => listener.closed?.(allowed.reason));
                return { renew: () => undefined, close: () => undefined };
            }
            const key = keyOf(address, prefix);
            let entry = entries.get(key);
            const listening: Listening = { listener, revision, expires: now() + leaseMs, chain: allowed.chain, readEnds: allowed.expires, ...(access === undefined ? {} : { access }) };
            if (entry === undefined) {
                entry = { address, prefix, upstream: undefined, ready: false, revision: 0, durable: 0, epoch: 0, root: {}, log: [], logFrom: 0, listeners: new Set() };
                entries.set(key, entry);
                report(CATEGORY, "A first listener of %s %s from revision %s", [address, prefix, revision]);
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
            report(CATEGORY, "A listener joined %s %s from revision %s: %s listeners", [address, prefix, revision, entry.listeners.size]);
            if (entry.ready) {
                serve(entry, listening, revision);
            }
            else {
                listening.waiting = revision;
            }
            return subscription(entry, listening);
        },
        sweep,
        revoke,
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
                if (!entry.listeners.has(listening)) {
                    return;
                }
                //each renewal checks the read again: a grant revoked or expired since ends it
                const allowed = readable(entry.address, entry.prefix, listening.access);
                if (!allowed.ok) {
                    remove(entry, listening, allowed.reason);
                    return;
                }
                listening.chain = allowed.chain;
                listening.readEnds = allowed.expires;
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

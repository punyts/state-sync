import type { Change, JsonValue } from "../Change.js";
import type { SyncMessage } from "../Messages.js";
import { createAuthority, type Authority, type AuthoritySession } from "./Authority.js";
import type { StoredNamespace } from "./NamespaceStorage.js";

/** Which node holds a namespace's authority, under which epoch, and until when its lease runs */
export interface OwnershipRecord {
    readonly address: string;
    readonly node: string;
    readonly epoch: number;
    /** Milliseconds since the epoch */
    readonly leaseUntil: number;
}

/**
 * Where ownership is kept (docs/design/statenet-relays.md, "One writer at a time"): `namespace_owner` in Postgres.
 * Every change of ownership is a compare-and-swap that raises the epoch by one
 */
export interface OwnershipStore {
    get(address: string): Promise<OwnershipRecord | undefined>;
    /**
     * Takes ownership: when nobody owns the namespace, when the owner's lease ran out (a takeover), or when `fromEpoch`
     * is the current epoch (a handoff). Undefined when refused
     */
    take(address: string, node: string, leaseMs: number, fromEpoch?: number): Promise<OwnershipRecord | undefined>;
    /** Renews the owner's lease; false when the node no longer owns the namespace at that epoch */
    renew(address: string, node: string, epoch: number, leaseMs: number): Promise<boolean>;
}

/** Storage that knows epochs: a save from an epoch older than the newest it has seen for the namespace is refused */
export interface EpochStorage {
    load(address: string): Promise<StoredNamespace | undefined>;
    save(address: string, stored: StoredNamespace, epoch: number): Promise<void>;
}

/** Thrown by an `EpochStorage` for a save from an older epoch: the node lost ownership */
export class FencedError extends Error {
    constructor(
        readonly address: string,
        /** The epoch of the refused save */
        readonly epoch: number,
        /** The newest epoch the namespace was saved under */
        readonly current: number
    ) {
        super(`${address} is at epoch ${current}: a write from epoch ${epoch} is refused`);
        this.name = "FencedError";
    }
}

/** Ownership in memory, for tests and one process */
export const createMemoryOwnershipStore = (now: () => number = Date.now): OwnershipStore => {
    const records = new Map<string, OwnershipRecord>();
    return {
        get: async (address) => records.get(address),
        take: async (address, node, leaseMs, fromEpoch) => {
            const current = records.get(address);
            const free = current === undefined || current.leaseUntil <= now() || (fromEpoch !== undefined && current.epoch === fromEpoch);
            if (!free) {
                return undefined;
            }
            const next: OwnershipRecord = { address, node, epoch: (current?.epoch ?? 0) + 1, leaseUntil: now() + leaseMs };
            records.set(address, next);
            return next;
        },
        renew: async (address, node, epoch, leaseMs) => {
            const current = records.get(address);
            if (current === undefined || current.node !== node || current.epoch !== epoch) {
                return false;
            }
            records.set(address, { ...current, leaseUntil: now() + leaseMs });
            return true;
        }
    };
};

/** Epoch storage in memory, for tests: it keeps copies and refuses saves from older epochs */
export const createMemoryEpochStorage = (): EpochStorage & { epochOf: (address: string) => number } => {
    const namespaces = new Map<string, { stored: StoredNamespace; epoch: number }>();
    return {
        load: async (address) => {
            const found = namespaces.get(address);
            return found === undefined ? undefined : structuredClone(found.stored);
        },
        save: async (address, stored, epoch) => {
            const current = namespaces.get(address)?.epoch ?? 0;
            if (epoch < current) {
                throw new FencedError(address, epoch, current);
            }
            namespaces.set(address, { stored: structuredClone(stored), epoch });
        },
        epochOf: (address) => namespaces.get(address)?.epoch ?? 0
    };
};

export interface ClaimPolicyOptions {
    /** How far back writes count; 10 seconds by default */
    windowMs?: number;
    /** The share of a namespace's writes one other node must send for ownership to move there; 0.8 by default */
    share?: number;
    /** The fewest writes in the window before a move is considered; 20 by default */
    minWrites?: number;
    /** How long after a move another one waits; 30 seconds by default */
    cooldownMs?: number;
    now?: () => number;
}

/**
 * When ownership pays to move (docs/design/statenet-relays.md, "Forward by default, move when it pays"): the owner
 * counts each namespace's writes by the node they came through, and moves ownership to another node only when that
 * node sent at least `share` of at least `minWrites` writes in the window, and not within `cooldownMs` of the last
 * move. Two nodes writing equally never pass the share, so ownership does not bounce between them
 */
export class ClaimPolicy {
    private readonly writes = new Map<string, Array<{ at: number; node: string }>>();
    private readonly lastMove = new Map<string, number>();
    private readonly windowMs: number;
    private readonly share: number;
    private readonly minWrites: number;
    private readonly cooldownMs: number;
    private readonly now: () => number;

    constructor(options: ClaimPolicyOptions = {}) {
        this.windowMs = options.windowMs ?? 10_000;
        this.share = options.share ?? 0.8;
        this.minWrites = options.minWrites ?? 20;
        this.cooldownMs = options.cooldownMs ?? 30_000;
        this.now = options.now ?? Date.now;
    }

    /** Counts a write of a namespace that came through a node */
    record(address: string, node: string): void {
        const at = this.now();
        const list = (this.writes.get(address) ?? []).filter((write) => write.at > at - this.windowMs);
        list.push({ at, node });
        this.writes.set(address, list);
    }

    /** The node ownership should move to, other than `owner`, or undefined */
    moveTo(address: string, owner: string): string | undefined {
        const at = this.now();
        if (at - (this.lastMove.get(address) ?? Number.NEGATIVE_INFINITY) < this.cooldownMs) {
            return undefined;
        }
        const list = (this.writes.get(address) ?? []).filter((write) => write.at > at - this.windowMs);
        if (list.length < this.minWrites) {
            return undefined;
        }
        const counts = new Map<string, number>();
        for (const write of list) {
            counts.set(write.node, (counts.get(write.node) ?? 0) + 1);
        }
        for (const [node, count] of counts) {
            if (node !== owner && count / list.length >= this.share) {
                return node;
            }
        }
        return undefined;
    }

    /** Notes a move, which starts the cooldown and the count afresh */
    moved(address: string): void {
        this.lastMove.set(address, this.now());
        this.writes.delete(address);
    }
}

/** What a write gets: applied (or adjusted) at a revision under an epoch, or rejected */
export type WriteOutcome =
    | { readonly result: "applied" | "adjusted"; readonly revision: number; readonly epoch: number; readonly value?: JsonValue }
    | { readonly result: "rejected"; readonly reason: string };

/** What the old owner gives the new one in a handoff: the revision the namespace is durable at, its epoch, and the writes that arrived meanwhile */
export interface Handoff {
    readonly revision: number;
    readonly epoch: number;
    readonly queued: ReadonlyArray<{ readonly change: Change; readonly done: (outcome: WriteOutcome) => void }>;
}

/**
 * Another owner node as this one reaches it: the `OwnerNode` itself in one process, or its side of a link over the mesh
 * (`@punyts/statenet`'s peer links)
 */
export interface NodePeer {
    /** A write for a namespace, sent on by the node it came through (`via`) */
    write(address: string, change: Change, via?: string): Promise<WriteOutcome>;
    /** Asks the peer to take the namespace from its owner */
    claim(address: string): Promise<boolean>;
    /** The owner's side of a claim by `to` */
    handoff(address: string, to: string): Promise<Handoff | undefined>;
}

/** The directory's view of a node: a link to it, or undefined when it is gone */
export type NodeLink = (nodeId: string) => NodePeer | undefined;

/**
 * Where the namespaces an owner node orders live: by default a plain authority per namespace over the `EpochStorage`;
 * a host with authorities of its own (an app's logic, its own storage) gives them here. A host fences its own saves:
 * it must refuse to save under an epoch older than the newest the namespace was saved under
 */
export interface NamespaceHost {
    /** The namespace's authority on this node, started (saving under `epoch`) when it is not running; it may be restarted between calls */
    authority(address: string, epoch: number): Promise<Authority>;
    /** This node stopped owning the namespace: close its authority */
    release(address: string): Promise<void> | void;
}

/** Where a namespace is ordered, as `place` finds it */
export type Placement = { readonly here: true; readonly epoch: number } | { readonly here: false; readonly node: string; readonly epoch: number };

export interface OwnerNodeOptions {
    readonly id: string;
    readonly ownership: OwnershipStore;
    /** Where a plain authority keeps its namespace; needed without a `host` */
    readonly storage?: EpochStorage;
    /** The authorities of a host that has its own; plain authorities over `storage` by default */
    readonly host?: NamespaceHost;
    /** The other nodes this one can reach */
    readonly link: NodeLink;
    /** 10 seconds by default; the lease is renewed every third of it */
    readonly leaseMs?: number;
    readonly policy?: ClaimPolicy;
    /** The state of a namespace nothing is stored for (plain authorities) */
    readonly initial?: (address: string) => { [key: string]: JsonValue };
    /** Tells when this node starts or stops owning a namespace, with the epoch */
    readonly onOwner?: (address: string, owning: boolean, epoch: number) => void;
    readonly renewEveryMs?: number;
    /** The clock, for tests */
    readonly now?: () => number;
}

interface Hosted {
    readonly epoch: number;
    /** False while handing off: writes queue for the new owner */
    ordering: boolean;
    readonly queue: Array<{ change: Change; done: (outcome: WriteOutcome) => void }>;
    timer?: ReturnType<typeof setInterval>;
}

/** The session an owner node orders changes through, on one authority (a restarted authority gets a new one) */
interface Ordering {
    readonly session: AuthoritySession;
    readonly waiting: Map<string, (outcome: WriteOutcome) => void>;
}

/** Plain authorities over epoch storage, one per namespace: the host of an owner node that has none of its own */
function plainHost(storage: EpochStorage, initial: (address: string) => { [key: string]: JsonValue }): NamespaceHost {
    const running = new Map<string, Promise<Authority>>();
    return {
        authority: (address, epoch) => {
            let found = running.get(address);
            if (found === undefined) {
                found = createAuthority({
                    namespace: address.replace(/[^A-Za-z0-9_-]+/g, "_"),
                    storage: { load: () => storage.load(address), save: (_namespace, stored) => storage.save(address, stored, epoch) },
                    initial: initial(address),
                    createParents: true
                });
                running.set(address, found);
                found.catch(() => running.delete(address));
            }
            return found;
        },
        release: async (address) => {
            const found = running.get(address);
            running.delete(address);
            (await found?.catch(() => undefined))?.close();
        }
    };
}

/**
 * An owner node (docs/design/statenet-relays.md, "One writer at a time, and ownership that moves"). It holds the
 * authority of each namespace it owns and orders its changes; a write for a namespace it does not own goes to the
 * owner. Ownership moves by a claim: the owner stops ordering and queues, waits until the namespace is durable up to its
 * last revision, and hands off the revision, its epoch and the queue; the claimant takes ownership with a
 * compare-and-swap on that epoch, loads the namespace from storage and applies the queue first. An owner whose lease
 * runs out stops at once, and its storage refuses its saves by epoch; another node takes over on the next write.
 * The authorities are the host's (`NamespaceHost`): plain ones by default, or an app server's own
 */
export class OwnerNode implements NodePeer {
    readonly id: string;
    private readonly hosted = new Map<string, Hosted>();
    /** Namespaces this node is taking: writes wait for it */
    private readonly taking = new Map<string, Promise<Hosted | undefined>>();
    /** Where namespaces this node handed off went, until the store says so */
    private readonly movedTo = new Map<string, string>();
    private readonly orderings = new WeakMap<Authority, Ordering>();
    private readonly host: NamespaceHost;
    private readonly leaseMs: number;
    private stopped = false;
    private readonly now: () => number;

    constructor(private readonly options: OwnerNodeOptions) {
        this.id = options.id;
        this.leaseMs = options.leaseMs ?? 10_000;
        this.now = options.now ?? Date.now;
        if (options.host === undefined && options.storage === undefined) {
            throw new Error("An owner node needs a host or an epoch storage");
        }
        this.host = options.host ?? plainHost(options.storage as EpochStorage, (address) => options.initial?.(address) ?? {});
    }

    /** The namespaces this node owns now */
    owned(): string[] {
        return [...this.hosted.keys()];
    }

    /** Whether this node owns a namespace now */
    owns(address: string): boolean {
        return this.hosted.has(address);
    }

    /** The authority of a namespace this node owns */
    async authorityOf(address: string): Promise<Authority | undefined> {
        const hosted = this.hosted.get(address);
        return hosted === undefined ? undefined : this.host.authority(address, hosted.epoch);
    }

    /** The epoch this node owns a namespace under, or undefined */
    epochOf(address: string): number | undefined {
        return this.hosted.get(address)?.epoch;
    }

    /**
     * Where a namespace is ordered: here when this node owns it, or takes it because nobody holds it (or its owner
     * lapsed or cannot be reached); otherwise the node that owns it
     */
    async place(address: string, attempt = 0): Promise<Placement> {
        if (this.stopped) {
            throw new Error(`node ${this.id} is stopped`);
        }
        const hosted = this.hosted.get(address) ?? (await this.taking.get(address));
        if (hosted !== undefined && this.hosted.get(address) === hosted) {
            return { here: true, epoch: hosted.epoch };
        }
        const record = await this.options.ownership.get(address);
        const moved = this.movedTo.get(address);
        const owner = moved ?? (record !== undefined && record.leaseUntil > this.now() ? record.node : undefined);
        if (owner !== undefined && owner !== this.id && this.options.link(owner) !== undefined) {
            return { here: false, node: owner, epoch: record?.epoch ?? 0 };
        }
        const taken = await this.take(address);
        if (taken !== undefined) {
            return { here: true, epoch: taken.epoch };
        }
        if (attempt < 2) {
            return this.place(address, attempt + 1);
        }
        throw new Error(`${address} could not be placed`);
    }

    /**
     * A write for a namespace, from a client of this node (`via` is this node) or forwarded by another. Ordered here
     * when this node owns it, queued while it hands off, and passed to the owner otherwise
     */
    async write(address: string, change: Change, via: string = this.id, attempt = 0): Promise<WriteOutcome> {
        if (this.stopped) {
            return { result: "rejected", reason: `node ${this.id} is stopped` };
        }
        const hosted = this.hosted.get(address) ?? (await this.taking.get(address));
        if (hosted !== undefined && this.hosted.get(address) === hosted) {
            this.options.policy?.record(address, via);
            if (!hosted.ordering) {
                return new Promise((done) => hosted.queue.push({ change, done }));
            }
            const outcome = await this.order(address, hosted, change);
            this.considerMove(address);
            return outcome;
        }
        const moved = this.movedTo.get(address);
        const record = await this.options.ownership.get(address);
        const owner = moved ?? (record !== undefined && record.leaseUntil > this.now() ? record.node : undefined);
        if (owner !== undefined && owner !== this.id) {
            const peer = this.options.link(owner);
            if (peer !== undefined) {
                return peer.write(address, change, via);
            }
        }
        // Nobody owns it, its owner's lease ran out, or its owner is unreachable and lapsed: take it over
        const taken = await this.take(address);
        if (taken === undefined) {
            // another node took it first (two first writes at once): look again, and send it there
            if (attempt < 2 && (await this.options.ownership.get(address))?.node !== record?.node) {
                return this.write(address, change, via, attempt + 1);
            }
            return { result: "rejected", reason: `${address} is owned by another node` };
        }
        return this.write(address, change, via, attempt);
    }

    /** Asks the owner for the namespace and takes it, as the design's claim; false when it could not */
    async claim(address: string): Promise<boolean> {
        if (this.hosted.has(address)) {
            return true;
        }
        const pending = this.taking.get(address);
        if (pending !== undefined) {
            return (await pending) !== undefined;
        }
        const record = await this.options.ownership.get(address);
        if (record === undefined || record.leaseUntil <= this.now() || record.node === this.id) {
            return (await this.take(address)) !== undefined;
        }
        const peer = this.options.link(record.node);
        if (peer === undefined) {
            return false;
        }
        let handoff: Handoff | undefined;
        const taking = (async () => {
            handoff = await peer.handoff(address, this.id);
            if (handoff === undefined) {
                return undefined;
            }
            return this.hostAt(address, handoff.epoch, handoff);
        })();
        this.taking.set(address, taking);
        try {
            const hosted = await taking;
            if (hosted === undefined && handoff !== undefined) {
                // the compare-and-swap lost: the queued writes go to whoever owns it now
                for (const { change, done } of handoff.queued) {
                    void this.write(address, change).then(done);
                }
            }
            return hosted !== undefined;
        }
        finally {
            this.taking.delete(address);
        }
    }

    /**
     * The owner's side of a claim: stops ordering, waits until the namespace is durable up to its last revision, and
     * gives the revision, its epoch and the writes that arrived meanwhile to the claimant. Writes after it go there
     */
    async handoff(address: string, to: string): Promise<Handoff | undefined> {
        const hosted = this.hosted.get(address);
        if (hosted === undefined) {
            return undefined;
        }
        hosted.ordering = false;
        const authority = await this.host.authority(address, hosted.epoch);
        await authority.whenDurable();
        await authority.flush();
        const revision = authority.revision();
        this.movedTo.set(address, to);
        await this.release(address, hosted);
        this.options.policy?.moved(address);
        const queued = hosted.queue.splice(0);
        return { revision, epoch: hosted.epoch, queued };
    }

    /** Stops: every hosted namespace is released (its lease left to run out, as when a node is lost) */
    async stop(): Promise<void> {
        this.stopped = true;
        await Promise.all([...this.hosted].map(([address, hosted]) => this.release(address, hosted)));
    }

    /** Takes a namespace nobody holds (or whose owner lapsed) and hosts it at the next epoch */
    private async take(address: string): Promise<Hosted | undefined> {
        const existing = this.taking.get(address);
        if (existing !== undefined) {
            return existing;
        }
        const taking = this.hostAt(address, undefined);
        this.taking.set(address, taking);
        try {
            return await taking;
        }
        finally {
            this.taking.delete(address);
        }
    }

    /** Takes ownership (a compare-and-swap on `fromEpoch` for a handoff), starts the authority and starts ordering */
    private async hostAt(address: string, fromEpoch: number | undefined, handoff?: Handoff): Promise<Hosted | undefined> {
        const record = await this.options.ownership.take(address, this.id, this.leaseMs, fromEpoch);
        if (record === undefined) {
            return undefined;
        }
        const epoch = record.epoch;
        const hosted: Hosted = { epoch, ordering: true, queue: [] };
        this.hosted.set(address, hosted);
        this.movedTo.delete(address);
        try {
            await this.host.authority(address, epoch);
        }
        catch (error) {
            this.hosted.delete(address);
            throw error;
        }
        this.options.onOwner?.(address, true, epoch);
        hosted.timer = setInterval(() => {
            void this.options.ownership.renew(address, this.id, epoch, this.leaseMs).then((still) => {
                if (!still && this.hosted.get(address) === hosted) {
                    // lost ownership: stop ordering at once
                    void this.release(address, hosted);
                }
            }, () => undefined);
        }, this.options.renewEveryMs ?? Math.max(10, this.leaseMs / 3));
        (hosted.timer as { unref?: () => void }).unref?.();
        // the writes that waited during the handoff land first, in the order they arrived
        for (const { change, done } of handoff?.queued ?? []) {
            done(await this.order(address, hosted, change));
        }
        return hosted;
    }

    /** Orders one change at the namespace's authority, which applies a resent change once */
    private async order(address: string, hosted: Hosted, change: Change): Promise<WriteOutcome> {
        const authority = await this.host.authority(address, hosted.epoch);
        const ordering = this.orderingOf(authority, hosted.epoch);
        return new Promise((done) => {
            ordering.waiting.set(change.id, done);
            ordering.session.receive(JSON.stringify({ type: "change", change }));
        });
    }

    /** The session this node orders through on an authority, connected on first use */
    private orderingOf(authority: Authority, epoch: number): Ordering {
        const found = this.orderings.get(authority);
        if (found !== undefined) {
            return found;
        }
        const waiting = new Map<string, (outcome: WriteOutcome) => void>();
        const session = authority.connect({
            send: (text) => {
                const message = JSON.parse(text) as SyncMessage;
                if (message.type !== "ack") {
                    return;
                }
                const done = waiting.get(message.id);
                waiting.delete(message.id);
                done?.(message.result === "rejected" ? { result: "rejected", reason: message.reason ?? "rejected" } : { result: message.result, revision: message.revision ?? 0, epoch, ...(message.value === undefined ? {} : { value: message.value }) });
            },
            close: () => {
                // the authority closed (released or restarted): what it had not answered is not known to be applied
                for (const done of waiting.values()) {
                    done({ result: "rejected", reason: "the namespace's authority closed" });
                }
                waiting.clear();
                this.orderings.delete(authority);
            }
        });
        session.receive(JSON.stringify({ type: "hello", namespace: authority.namespace, revision: authority.revision(), clientId: `node:${this.id}`, protocol: 2 }));
        const ordering: Ordering = { session, waiting };
        this.orderings.set(authority, ordering);
        return ordering;
    }

    private async release(address: string, hosted: Hosted): Promise<void> {
        if (hosted.timer !== undefined) {
            clearInterval(hosted.timer);
        }
        if (this.hosted.get(address) !== hosted) {
            return;
        }
        this.hosted.delete(address);
        await this.host.release(address);
        this.options.onOwner?.(address, false, hosted.epoch);
    }

    /** Moves ownership to the node that sends most of the writes, when the policy says it pays */
    private considerMove(address: string): void {
        const to = this.options.policy?.moveTo(address, this.id);
        if (to === undefined) {
            return;
        }
        const peer = this.options.link(to);
        if (peer !== undefined) {
            void peer.claim(address);
        }
    }
}

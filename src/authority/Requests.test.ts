import { describe, expect, it } from "vitest";
import { createStore } from "@punyts/state";
import { createStoreBridge } from "../Bridge.js";
import { createSyncClient } from "../Client.js";
import type { SyncMessage, SyncRequest } from "../Messages.js";
import { createInProcessTransport, settle } from "../__fixtures__/InProcessTransport.js";
import { createAuthority, type AuthorityOptions } from "./Authority.js";
import { generateGrantKey, readGrant, RevocationList, signGrant } from "./Grants.js";
import type { GrantClaims, GrantKey, GrantRight } from "./Grants.js";
import { createMemoryNamespaceStorage, isResave, type NamespaceStorage } from "./NamespaceStorage.js";
import { createMemoryEpochStorage, createMemoryOwnershipStore, OwnerNode } from "./Ownership.js";

/** Alice's app `notes`: `$.apps.notes` of her tree */
const ADDRESS = "alice/apps/notes";
const NAMESPACE = "alice.notes";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const START = 1_800_000_000_000;

/** Alice's key and the directory's view of it */
const keys = () => {
    const alice = generateGrantKey();
    const directory = new Map<string, GrantKey>([["alice-1", { ownerId: "alice", publicKey: alice.publicKey }]]);
    return { alice, keyOf: (kid: string) => directory.get(kid) };
};

/** A grant from Alice on her notes, by default to Bob to request */
const grantOf = (privateKey: string, rights: GrantRight[], claims: Partial<GrantClaims> = {}) =>
    signGrant({ kid: "alice-1", issuer: "alice", subject: "bob", owner: "alice", pattern: "$.apps.notes.data", rights, issued: START, expires: START + 30 * DAY, ...claims }, privateKey);

const hello = (protocol = 3) => JSON.stringify({ type: "hello", namespace: NAMESPACE, revision: 0, clientId: `client-${protocol}`, protocol });
const change = (id: string, path: string, value: unknown, base = 0) => JSON.stringify({ type: "change", change: { id, path, op: "set", value, base } });

/** Alice's authority with access checked, a clock, and sessions that record what they are sent */
const setup = async (options: Partial<AuthorityOptions> = {}, storage: NamespaceStorage = createMemoryNamespaceStorage()) => {
    const { alice, keyOf } = keys();
    const revocations = new RevocationList();
    const clock = { now: START };
    const authority = await createAuthority({
        namespace: NAMESPACE,
        storage,
        initial: { data: { notes: {} } },
        access: { address: ADDRESS, context: () => ({ keyOf, now: clock.now, revoked: (entry) => revocations.has(entry) }) },
        ...options,
        requests: { now: () => clock.now, ...options.requests }
    });
    const join = (subject: string, grant?: string, protocol = 3) => {
        const received: SyncMessage[] = [];
        const session = authority.connect({ send: (text) => received.push(JSON.parse(text)), close: () => undefined }, grant === undefined ? { subject } : { subject, grant });
        session.receive(hello(protocol));
        const of = <T extends SyncMessage["type"]>(type: T) => received.filter((message): message is Extract<SyncMessage, { type: T }> => message.type === type);
        return { received, session, of };
    };
    return { authority, alice, clock, revocations, join, storage };
};

describe("requests", () => {
    it("should keep a change from someone who may only request it as a request, told to its requester and the owner", async () => {
        // Arrange
        const { authority, alice, join } = await setup();
        const owner = join("alice");
        const bob = join("bob", grantOf(alice.privateKey, ["request"]));

        // Act
        bob.session.receive(change("r1", "$.data.notes.n1", "Hello"));

        // Assert
        expect(bob.of("ack")).toEqual([{ type: "ack", id: "r1", result: "requested" }]);
        const sent: SyncRequest = { id: "r1", path: "$.data.notes.n1", op: "set", value: "Hello", base: 0, by: "bob", mine: true, at: START, until: START + 7 * DAY, status: "pending" };
        expect(bob.of("requested")).toEqual([{ type: "requested", request: sent }]);
        expect(owner.of("requested")).toEqual([{ type: "requested", request: { ...sent, mine: false } }]);
        expect(authority.get("$.data.notes")).toEqual({});
        expect(authority.revision()).toBe(0);
    });

    it("should reject a change that would be a request from a protocol 2 client, and one from someone who may not request", async () => {
        // Arrange
        const { alice, join } = await setup();
        const old = join("bob", grantOf(alice.privateKey, ["request"]), 2);
        const reader = join("carol", grantOf(alice.privateKey, ["read"], { subject: "carol" }));

        // Act
        old.session.receive(change("r1", "$.data.notes.n1", "Hello"));
        reader.session.receive(change("r2", "$.data.notes.n1", "Hello"));

        // Assert
        expect(old.of("ack")).toMatchObject([{ id: "r1", result: "rejected", code: "access" }]);
        expect(reader.of("ack")).toMatchObject([{ id: "r2", result: "rejected", code: "access" }]);
    });

    it("should apply an approved request as its requester's, through the owner's logic, and tell everyone who saw it", async () => {
        // Arrange
        const { authority, alice, join } = await setup();
        const contexts: unknown[] = [];
        authority.onChange("$.data.notes", (context) => {
            contexts.push({ clientId: context.clientId, stale: context.stale, request: context.request });
            return undefined;
        });
        const owner = join("alice");
        const bob = join("bob", grantOf(alice.privateKey, ["request"]));
        bob.session.receive(change("r1", "$.data.notes.n1", "Hello"));
        owner.session.receive(change("w1", "$.data.notes.n1", "Mine"));

        // Act
        owner.session.receive(JSON.stringify({ type: "approve", id: "r1" }));

        // Assert
        expect(authority.get("$.data.notes.n1")).toBe("Hello");
        expect(contexts[1]).toEqual({ clientId: "client-3", stale: true, request: { by: "bob", at: START, approvedBy: "alice" } });
        expect(bob.of("changes").flatMap((message) => message.changes).map((each) => each.id)).toEqual(["w1", "r1"]);
        expect(bob.of("decided")).toEqual([{ type: "decided", id: "r1", status: "approved", decidedAt: START }]);
        expect(owner.of("decided")).toEqual([{ type: "decided", id: "r1", status: "approved", decidedAt: START }]);
        bob.session.receive(change("r1", "$.data.notes.n1", "Hello"));
        expect(bob.of("ack").at(-1)).toEqual({ type: "ack", id: "r1", result: "applied", revision: 2 });
    });

    it("should end a request the owner's logic refuses on approval as rejected with the logic's code", async () => {
        // Arrange
        const { authority, alice, join } = await setup();
        authority.onChange("$.data.notes", (context) => (context.request === undefined ? undefined : { result: "reject", reason: "taken" }));
        const owner = join("alice");
        const bob = join("bob", grantOf(alice.privateKey, ["request"]));
        bob.session.receive(change("r1", "$.data.notes.n1", "Hello"));

        // Act
        const outcome = authority.decide({ id: "r1", action: "approve" }, { subject: "alice" });

        // Assert
        expect(outcome).toEqual({ ok: true, status: "rejected" });
        expect(bob.of("decided")).toEqual([{ type: "decided", id: "r1", status: "rejected", decidedAt: START, code: "logic" }]);
        expect(authority.get("$.data.notes")).toEqual({});
        expect(owner.of("error")).toEqual([]);
    });

    it("should let someone who may read and write decide, not someone who may only write, and let only the requester withdraw", async () => {
        // Arrange
        const { authority, alice, join } = await setup();
        const admin = join("dora", grantOf(alice.privateKey, ["read", "write"], { subject: "dora" }));
        const writer = join("erin", grantOf(alice.privateKey, ["write"], { subject: "erin" }));
        const bob = join("bob", grantOf(alice.privateKey, ["request"]));
        bob.session.receive(change("r1", "$.data.notes.n1", "One"));
        bob.session.receive(change("r2", "$.data.notes.n2", "Two"));

        // Act
        writer.session.receive(JSON.stringify({ type: "approve", id: "r1" }));
        admin.session.receive(JSON.stringify({ type: "withdraw", id: "r1" }));
        admin.session.receive(JSON.stringify({ type: "reject", id: "r1", note: "Not now" }));
        bob.session.receive(JSON.stringify({ type: "withdraw", id: "r2" }));
        bob.session.receive(JSON.stringify({ type: "approve", id: "r2" }));

        // Assert
        expect(writer.of("requested")).toEqual([]);
        expect(writer.of("error")).toMatchObject([{ code: "not-allowed" }]);
        expect(admin.of("requested").map((message) => message.request.id)).toEqual(["r1", "r2"]);
        expect(admin.of("error")).toMatchObject([{ code: "not-allowed" }]);
        expect(bob.of("decided")).toEqual([
            { type: "decided", id: "r1", status: "rejected", decidedAt: START, note: "Not now" },
            { type: "decided", id: "r2", status: "withdrawn", decidedAt: START }
        ]);
        expect(bob.of("error")).toMatchObject([{ code: "no-request" }]);
        expect(authority.requests().map((request) => [request.change.id, request.status, request.decidedBy])).toEqual([
            ["r1", "rejected", "dora"],
            ["r2", "withdrawn", undefined]
        ]);
    });

    it("should expire a request past its time and end one whose permission was revoked, and forget decided ones after they were kept", async () => {
        // Arrange
        const { authority, alice, clock, revocations, join } = await setup({ requests: { lifeMs: DAY, keepMs: 2 * DAY } });
        const grant = grantOf(alice.privateKey, ["request"]);
        const bob = join("bob", grant);
        const carolGrant = grantOf(alice.privateKey, ["request"], { subject: "carol", expires: START + HOUR });
        const carol = join("carol", carolGrant);
        bob.session.receive(change("r1", "$.data.notes.n1", "One"));
        carol.session.receive(change("r2", "$.data.notes.n2", "Two"));

        // Act
        revocations.add(readGrant(grant)?.entry as string, START + 30 * DAY);
        const revoked = authority.requests().map((request) => request.status);
        clock.now = START + HOUR;
        const late = join("alice");
        const atHour = authority.requests().map((request) => request.status);
        clock.now = START + 4 * DAY;
        join("alice");

        // Assert
        expect(carol.of("requested")[0]?.request.until).toBe(START + HOUR);
        expect(revoked).toEqual(["pending", "pending"]);
        expect(atHour).toEqual(["revoked", "expired"]);
        expect(bob.of("decided")).toMatchObject([{ id: "r1", status: "revoked" }]);
        expect(carol.of("decided")).toMatchObject([{ id: "r2", status: "expired" }]);
        expect(late.of("welcome")[0]?.requests).toEqual([]);
        expect(authority.requests()).toEqual([]);
    });

    it("should refuse a request past the most of one requester with unsaved", async () => {
        // Arrange
        const { alice, join } = await setup({ requests: { perRequester: 2 } });
        const bob = join("bob", grantOf(alice.privateKey, ["request"]));

        // Act
        ["r1", "r2", "r3"].forEach((id) => bob.session.receive(change(id, `$.data.notes.${id}`, id)));

        // Assert
        expect(bob.of("ack").map((ack) => [ack.id, ack.result, ack.code])).toEqual([
            ["r1", "requested", undefined],
            ["r2", "requested", undefined],
            ["r3", "rejected", "unsaved"]
        ]);
    });

    it("should keep a pending request across a restart, in the requester's welcome and in the owner's", async () => {
        // Arrange
        const storage = createMemoryNamespaceStorage();
        const first = await setup({}, storage);
        const grant = grantOf(first.alice.privateKey, ["request"]);
        first.join("bob", grant).session.receive(change("r1", "$.data.notes.n1", "Hello"));
        await first.authority.flush();
        first.authority.close();

        // Act
        const second = await createAuthority({ namespace: NAMESPACE, storage, initial: {}, access: { address: ADDRESS, context: () => ({ keyOf: (kid) => (kid === "alice-1" ? { ownerId: "alice", publicKey: first.alice.publicKey } : undefined), now: START }) }, requests: { now: () => START } });
        const welcomes = ["bob", "alice"].map((subject) => {
            const received: SyncMessage[] = [];
            const session = second.connect({ send: (text) => received.push(JSON.parse(text)), close: () => undefined }, subject === "bob" ? { subject, grant } : { subject });
            session.receive(hello());
            return received[0];
        });

        // Assert
        expect(welcomes.map((welcome) => (welcome?.type === "welcome" ? welcome.requests?.map((request) => [request.id, request.mine]) : undefined))).toEqual([[["r1", true]], [["r1", false]]]);
        expect((await storage.load(NAMESPACE))?.serial).toBe(1);
        second.close();
    });

    it("should keep a sync client's requests in its list, approved by the owner's client", async () => {
        // Arrange
        const { authority, alice } = await setup();
        const grant = grantOf(alice.privateKey, ["request"]);
        const { transport } = createInProcessTransport({ ...authority, connect: (connection) => authority.connect(connection, { subject: "bob", grant }) });
        const owners = createInProcessTransport({ ...authority, connect: (connection) => authority.connect(connection, { subject: "alice" }) });
        const store = createStore<any>({});
        const lists: string[][] = [];
        const bob = createSyncClient({ namespace: NAMESPACE, bridge: createStoreBridge(store), transport, clientId: "bob-tab", onRequests: (requests) => lists.push(requests.map((request) => `${request.id}:${request.status}`)) });
        const owner = createSyncClient({ namespace: NAMESPACE, bridge: createStoreBridge(createStore<any>({})), transport: owners.transport, clientId: "alice-tab" });
        bob.start();
        owner.start();
        await settle();

        // Act
        store.set("$.data.notes.n1", "Hello");
        await settle();
        const meanwhile = store.get("$.data.notes.n1");
        const asked = owner.requests().map((request) => [request.id, request.mine]);
        owner.approve(asked[0]?.[0] as string);
        await settle();

        // Assert
        expect(meanwhile).toBeUndefined();
        expect(asked).toEqual([[expect.any(String), false]]);
        expect(lists.at(-1)).toEqual([`${asked[0]?.[0]}:approved`]);
        expect(store.get("$.data.notes.n1")).toBe("Hello");
        bob.stop();
        owner.stop();
    });
});

describe("serial", () => {
    it("should write a save that takes no revision under the same epoch, and skip one sent again", async () => {
        // Arrange
        const storage = createMemoryEpochStorage();
        const at = (revision: number, serial: number) => ({ state: { serial }, revision, log: [], applied: [], serial });

        // Act
        await storage.save(ADDRESS, at(3, 3), 1);
        await storage.save(ADDRESS, at(3, 4), 1);
        await storage.save(ADDRESS, at(3, 4), 1);
        await storage.save(ADDRESS, at(2, 9), 1);

        // Assert
        expect((await storage.load(ADDRESS))?.state).toEqual({ serial: 4 });
        expect(isResave({ revision: 5 }, { revision: 4, serial: 9 })).toBe(false);
    });

    it("should answer a write forwarded with access to an owner node that checks it as requested", async () => {
        // Arrange
        const { alice, keyOf } = keys();
        const node = new OwnerNode({ id: "a", ownership: createMemoryOwnershipStore(), storage: createMemoryEpochStorage(), link: () => undefined, initial: () => ({ data: { notes: {} } }), access: () => ({ keyOf, now: START }) });
        const id = globalThis.crypto.randomUUID();

        // Act
        const outcome = await node.write(ADDRESS, { id, path: "$.data.notes.n1", op: "set", value: "Hello", base: 0 }, "b", { subject: "bob", grant: grantOf(alice.privateKey, ["request"]) });
        const anonymous = await node.write(ADDRESS, { id: globalThis.crypto.randomUUID(), path: "$.data.notes.n1", op: "set", value: "Hello", base: 0 });

        // Assert
        expect(outcome).toEqual({ result: "requested", epoch: 1 });
        expect(anonymous).toMatchObject({ result: "rejected", code: "access" });
        expect((await node.authorityOf(ADDRESS))?.requests().map((request) => request.change.id)).toEqual([id]);
        await node.stop();
    });
});

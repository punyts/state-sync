import { describe, expect, it } from "vitest";
import type { SyncMessage } from "../Messages.js";
import { createAuthority } from "./Authority.js";
import { addressCovers, generateGrantKey, RevocationList, signGrant, verifyGrant } from "./Grants.js";
import type { GrantClaims, GrantKey } from "./Grants.js";
import { createMemoryNamespaceStorage } from "./NamespaceStorage.js";
import { createAuthorityUpstream, createRelay } from "./Relay.js";
import type { RelayListener } from "./Relay.js";

const ADDRESS = "alice/notes/user";
const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;

/** Alice's and Bob's keys, as Magnetic holds them, and the directory's view of their public parts */
const keys = () => {
    const alice = generateGrantKey();
    const bob = generateGrantKey();
    const directory = new Map<string, GrantKey>([
        ["alice-1", { ownerId: "alice", publicKey: alice.publicKey }],
        ["bob-1", { ownerId: "bob", publicKey: bob.publicKey }]
    ]);
    return { alice, bob, directory, keyOf: (kid: string) => directory.get(kid) };
};

const root = (privateKey: string, claims: Partial<GrantClaims> = {}) =>
    signGrant({ kid: "alice-1", issuer: "alice", subject: "bob", address: ADDRESS, prefix: "$.data", rights: ["read", "write"], issued: NOW, expires: NOW + HOUR, ...claims }, privateKey);

const listener = () => {
    const state: { welcomed: boolean; closed?: string } = { welcomed: false };
    const it: RelayListener = { welcome: () => (state.welcomed = true), changes: () => undefined, closed: (reason) => (state.closed = reason) };
    return { listener: it, state };
};

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const owner = async () => {
    const authority = await createAuthority({ namespace: "alice.notes", storage: createMemoryNamespaceStorage(), initial: { data: { notes: {} } } });
    return { authority, upstream: createAuthorityUpstream(async (address) => (address === ADDRESS ? authority : undefined)) };
};

describe("verifyGrant", () => {
    it("should accept a grant the owner of the address signed, and nothing signed by anyone else for it", () => {
        const { alice, bob, keyOf } = keys();

        expect(verifyGrant(root(alice.privateKey), { keyOf, now: NOW })).toMatchObject({ ok: true, grant: { subject: "bob" } });
        expect(verifyGrant(signGrant({ kid: "bob-1", issuer: "bob", subject: "bob", address: ADDRESS, prefix: "$", rights: ["read"], issued: NOW, expires: NOW + HOUR }, bob.privateKey), { keyOf, now: NOW })).toMatchObject({ ok: false });
        expect(verifyGrant(root(bob.privateKey), { keyOf, now: NOW })).toEqual({ ok: false, reason: "the signature does not match" });
        expect(verifyGrant(root(alice.privateKey, { expires: NOW }), { keyOf, now: NOW })).toEqual({ ok: false, reason: "expired" });
    });

    it("should never let a passed-on grant be wider than the one it came from", () => {
        // Arrange
        const { alice, bob, keyOf } = keys();
        const parent = root(alice.privateKey, { prefix: "$.data.notes", rights: ["read"] });
        const passOn = (claims: Partial<GrantClaims>) =>
            verifyGrant(signGrant({ kid: "bob-1", issuer: "bob", subject: "carol", address: ADDRESS, prefix: "$.data.notes.n1", rights: ["read"], issued: NOW, expires: NOW + HOUR, parent, ...claims }, bob.privateKey), { keyOf, now: NOW });

        // Act and assert
        expect(passOn({})).toMatchObject({ ok: true, chain: [expect.any(String), expect.any(String)] });
        for (const wider of [{ prefix: "$.data" }, { rights: ["read", "write"] as const }, { expires: NOW + 2 * HOUR }, { address: "alice/other/user" }]) {
            expect(passOn(wider), JSON.stringify(wider)).toEqual({ ok: false, reason: "wider than the grant it was passed on from" });
        }
        expect(verifyGrant(signGrant({ kid: "alice-1", issuer: "alice", subject: "carol", address: ADDRESS, prefix: "$.data.notes", rights: ["read"], issued: NOW, expires: NOW + HOUR, parent }, alice.privateKey), { keyOf, now: NOW })).toEqual({ ok: false, reason: "passed on by someone the grant was not given to" });
    });

    it("should keep verifying grants of a rotated key until they expire, and refuse what it signs after", () => {
        // Arrange
        const { alice, directory, keyOf } = keys();
        const old = root(alice.privateKey);
        const next = generateGrantKey();
        directory.set("alice-1", { ...(directory.get("alice-1") as GrantKey), retiredAt: NOW + 1 });
        directory.set("alice-2", { ownerId: "alice", publicKey: next.publicKey });

        // Act and assert
        expect(verifyGrant(old, { keyOf, now: NOW + HOUR / 2 }).ok).toBe(true);
        expect(verifyGrant(old, { keyOf, now: NOW + HOUR }).ok).toBe(false);
        expect(verifyGrant(root(alice.privateKey, { issued: NOW + 2 }), { keyOf, now: NOW + 3 })).toEqual({ ok: false, reason: "signed with a retired key" });
        expect(verifyGrant(root(next.privateKey, { kid: "alice-2", issued: NOW + 2 }), { keyOf, now: NOW + 3 }).ok).toBe(true);
    });
});

describe("addressCovers", () => {
    it("should let a granted address name every app with *, but never every owner", () => {
        expect(addressCovers("alice/*/user", "alice/notes/user")).toBe(true);
        expect(addressCovers("alice/*/user", "alice/notes/app")).toBe(false);
        expect(addressCovers("*/notes/user", "alice/notes/user")).toBe(false);
    });
});

describe("grants at the relay and the owner node", () => {
    it("should refuse a read without a grant, with an expired one or a revoked one at the relay, and let the owner read", async () => {
        // Arrange
        const { alice, keyOf } = keys();
        let clock = NOW;
        const node = await owner();
        const relay = createRelay(node.upstream, { sweep: false, now: () => clock, grants: { keyOf } });
        const revoked = root(alice.privateKey);
        relay.revoke(JSON.parse(Buffer.from(revoked.split(".")[0] as string, "base64url").toString()).id, NOW + HOUR);
        const [none, expired, wasRevoked, mine, granted] = [listener(), listener(), listener(), listener(), listener()];

        // Act
        relay.subscribe(ADDRESS, "$.data", undefined, none.listener, { subject: "bob" });
        relay.subscribe(ADDRESS, "$.data", undefined, expired.listener, { subject: "bob", grant: root(alice.privateKey, { expires: NOW - 1 }) });
        relay.subscribe(ADDRESS, "$.data", undefined, wasRevoked.listener, { subject: "bob", grant: revoked });
        relay.subscribe(ADDRESS, "$.data", undefined, mine.listener, { subject: "alice" });
        const kept = relay.subscribe(ADDRESS, "$.data.notes", undefined, granted.listener, { subject: "bob", grant: root(alice.privateKey) });
        await tick();
        clock = NOW + HOUR;
        kept.renew();

        // Assert
        expect(none.state).toEqual({ welcomed: false, closed: "a read of alice/notes/user needs a grant" });
        expect(expired.state).toEqual({ welcomed: false, closed: "expired" });
        expect(wasRevoked.state).toEqual({ welcomed: false, closed: "revoked" });
        expect(mine.state).toEqual({ welcomed: true });
        expect(granted.state).toEqual({ welcomed: true, closed: "expired" });
    });

    it("should close every listener that used a revoked grant, and everything passed on from it, through the relays below", async () => {
        // Arrange: Bob reads with Alice's grant and passes a narrower one to Carol, who reads through a relay below
        const { alice, bob, keyOf } = keys();
        const node = await owner();
        const top = createRelay(node.upstream, { sweep: false, now: () => NOW, grants: { keyOf }, trustedNodes: (subject) => subject === "relay-eu" });
        const below = createRelay(top, { sweep: false, now: () => NOW, grants: { keyOf }, node: "relay-eu" });
        const fromAlice = root(alice.privateKey);
        const toCarol = signGrant({ kid: "bob-1", issuer: "bob", subject: "carol", address: ADDRESS, prefix: "$.data.notes", rights: ["read"], issued: NOW, expires: NOW + HOUR, parent: fromAlice }, bob.privateKey);
        const [bobReads, carolReads, aliceReads] = [listener(), listener(), listener()];
        top.subscribe(ADDRESS, "$.data", undefined, bobReads.listener, { subject: "bob", grant: fromAlice });
        below.subscribe(ADDRESS, "$.data.notes", undefined, carolReads.listener, { subject: "carol", grant: toCarol });
        top.subscribe(ADDRESS, "$.data", undefined, aliceReads.listener, { subject: "alice" });
        await tick();

        // Act
        top.revoke(JSON.parse(Buffer.from(fromAlice.split(".")[0] as string, "base64url").toString()).id, NOW + HOUR);

        // Assert
        expect(bobReads.state.closed).toBe("revoked");
        expect(carolReads.state.closed).toBe("revoked");
        expect(aliceReads.state.closed).toBeUndefined();
        expect(below.stats()).toEqual({ upstream: 0, listeners: 0 });
    });

    it("should refuse a write with a revoked grant at the owner node at once, and take one with a grant that covers it", async () => {
        // Arrange
        const { alice, keyOf } = keys();
        const revocations = new RevocationList();
        const authority = await createAuthority({ namespace: "alice.notes", storage: createMemoryNamespaceStorage(), initial: { data: { notes: {} } }, access: { address: ADDRESS, context: () => ({ keyOf, now: NOW, revoked: (id) => revocations.has(id) }) } });
        const grant = root(alice.privateKey, { prefix: "$.data.notes" });
        const received: SyncMessage[] = [];
        const session = authority.connect({ send: (text) => received.push(JSON.parse(text)), close: () => undefined }, { subject: "bob", grant });
        session.receive(JSON.stringify({ type: "hello", namespace: "alice.notes", revision: 0, clientId: "b", protocol: 2 }));
        const change = (id: string, path: string) => session.receive(JSON.stringify({ type: "change", change: { id, path, op: "set", value: "x", base: 0 } }));

        // Act
        change("c1", "$.data.notes.n1");
        change("c2", "$.data.other");
        revocations.add(JSON.parse(Buffer.from(grant.split(".")[0] as string, "base64url").toString()).id, NOW + HOUR);
        change("c3", "$.data.notes.n2");

        // Assert
        const acks = received.filter((message) => message.type === "ack");
        expect(acks).toEqual([
            { type: "ack", id: "c1", result: "applied", revision: 1 },
            { type: "ack", id: "c2", result: "rejected", reason: "the grant does not let bob write $.data.other of alice/notes/user", code: "access" },
            { type: "ack", id: "c3", result: "rejected", reason: "revoked", code: "access" }
        ]);
    });
});

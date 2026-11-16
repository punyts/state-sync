import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";

/** What a grant lets its subject do under its prefix */
export type GrantRight = "read" | "write";

/**
 * A right to read or write paths at an address (docs/design/statenet-relays.md, "Grants"), signed by its issuer's
 * key. A grant the owner of the address issues is a root; one a subject passes on embeds the grant it came from as
 * `parent`, and may only narrow it
 */
export interface GrantClaims {
    readonly id: string;
    /** The id of the key that signed it */
    readonly kid: string;
    /** Who gave it: the owner of the address for a root, the subject of `parent` for one passed on */
    readonly issuer: string;
    /** Who may use it: a user, an app or a node */
    readonly subject: string;
    readonly address: string;
    /** The "$."-prefixed path it covers, and everything below */
    readonly prefix: string;
    readonly rights: readonly GrantRight[];
    /** When it was signed and when it stops working, in milliseconds since the epoch */
    readonly issued: number;
    readonly expires: number;
    /** The token of the grant it was passed on from */
    readonly parent?: string;
}

/** A public key, as the directory gives it: whose it is, and when it stopped signing */
export interface GrantKey {
    readonly ownerId: string;
    /** The public key, SPKI DER in base64url */
    readonly publicKey: string;
    /** Grants issued after this verify no longer; those before it verify until they expire */
    readonly retiredAt?: number;
}

export interface GrantContext {
    /** The public key of a key id; undefined when there is none */
    readonly keyOf: (kid: string) => GrantKey | undefined;
    readonly now: number;
    /** Whether a grant id was revoked */
    readonly revoked?: (grantId: string) => boolean;
}

export type GrantCheck =
    | { readonly ok: true; readonly grant: GrantClaims; readonly chain: readonly string[] }
    | { readonly ok: false; readonly reason: string };

/** The most grants in one chain */
export const MAX_GRANT_DEPTH = 8;

const encode = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString("base64url");
const decode = (text: string): Buffer => Buffer.from(text, "base64url");
const segmentsOf = (path: string): string[] => (path === "$" ? [] : path.slice(2).split("."));

/** The owner of an address: its first segment */
export const ownerOfAddress = (address: string): string => address.split("/")[0] ?? "";

/**
 * True when a granted address covers an address: the same, or with `*` for a segment after the owner (an org's
 * standing read of a member's state names every app as `*`)
 */
export const addressCovers = (granted: string, address: string): boolean => {
    const outer = granted.split("/");
    const inner = address.split("/");
    return outer.length === inner.length && outer.every((segment, index) => segment === inner[index] || (index > 0 && segment === "*"));
};

/** True when a path is at or below a prefix */
export const isWithinPrefix = (prefix: string, path: string): boolean => {
    const outer = segmentsOf(prefix);
    const inner = segmentsOf(path);
    return outer.length <= inner.length && outer.every((segment, index) => segment === inner[index]);
};

/** A new signing key: its private part (PKCS#8 DER) and its public part (SPKI DER), both base64url */
export const generateGrantKey = (): { privateKey: string; publicKey: string } => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return {
        privateKey: encode(privateKey.export({ format: "der", type: "pkcs8" })),
        publicKey: encode(publicKey.export({ format: "der", type: "spki" }))
    };
};

const privateKeyOf = (key: string | KeyObject): KeyObject => (typeof key === "string" ? createPrivateKey({ key: decode(key), format: "der", type: "pkcs8" }) : key);
const publicKeyOf = (key: string): KeyObject => createPublicKey({ key: decode(key), format: "der", type: "spki" });

/** Signs a grant's claims with a private key; the token is the claims and the signature, each base64url */
export const signGrant = (claims: Omit<GrantClaims, "id"> & { id?: string }, privateKey: string | KeyObject): string => {
    const full: GrantClaims = { ...claims, id: claims.id ?? randomUUID() };
    const body = encode(JSON.stringify(full));
    return `${body}.${encode(sign(null, Buffer.from(body), privateKeyOf(privateKey)))}`;
};

/** The claims of a token without checking it, or undefined when it is not one */
export const readGrant = (token: string): GrantClaims | undefined => {
    const [body] = token.split(".");
    try {
        const claims = JSON.parse(decode(body ?? "").toString("utf8")) as GrantClaims;
        return typeof claims === "object" && claims !== null && typeof claims.id === "string" ? claims : undefined;
    }
    catch {
        return undefined;
    }
};

/**
 * Checks a grant and the chain it came from: every signature by its issuer's key (a key retired before a grant was
 * issued does not count), the root issued by the owner of the address, each grant passed on by the subject of the
 * one before and no wider than it (the same address, a prefix within, rights among, an expiry no later), nothing
 * expired, nothing in the chain revoked. Answers the grant with the ids of its chain, root last
 */
export const verifyGrant = (token: string, context: GrantContext, depth = 0): GrantCheck => {
    if (depth >= MAX_GRANT_DEPTH) {
        return { ok: false, reason: `a grant chain is at most ${MAX_GRANT_DEPTH} long` };
    }
    const [body, signature, rest] = token.split(".");
    const claims = readGrant(token);
    if (body === undefined || signature === undefined || rest !== undefined || claims === undefined) {
        return { ok: false, reason: "not a grant" };
    }
    const key = context.keyOf(claims.kid);
    if (key === undefined) {
        return { ok: false, reason: "signed with a key nobody knows" };
    }
    let signed = false;
    try {
        signed = verify(null, Buffer.from(body), publicKeyOf(key.publicKey), decode(signature));
    }
    catch {
        signed = false;
    }
    if (!signed) {
        return { ok: false, reason: "the signature does not match" };
    }
    if (key.ownerId !== claims.issuer) {
        return { ok: false, reason: "signed by someone other than its issuer" };
    }
    if (key.retiredAt !== undefined && claims.issued > key.retiredAt) {
        return { ok: false, reason: "signed with a retired key" };
    }
    if (claims.expires <= context.now) {
        return { ok: false, reason: "expired" };
    }
    if (context.revoked?.(claims.id) === true) {
        return { ok: false, reason: "revoked" };
    }
    if (claims.parent === undefined) {
        if (claims.issuer !== ownerOfAddress(claims.address)) {
            return { ok: false, reason: "a grant must come from the owner of the address, or be passed on from one that does" };
        }
        return { ok: true, grant: claims, chain: [claims.id] };
    }
    const parent = verifyGrant(claims.parent, context, depth + 1);
    if (!parent.ok) {
        return parent;
    }
    const from = parent.grant;
    if (from.subject !== claims.issuer) {
        return { ok: false, reason: "passed on by someone the grant was not given to" };
    }
    if (!addressCovers(from.address, claims.address) || !isWithinPrefix(from.prefix, claims.prefix) || !claims.rights.every((right) => from.rights.includes(right)) || claims.expires > from.expires) {
        return { ok: false, reason: "wider than the grant it was passed on from" };
    }
    return { ok: true, grant: claims, chain: [claims.id, ...parent.chain] };
};

/** Whether a checked grant lets a subject use a right at a path of an address */
export const grantAllows = (grant: GrantClaims, need: { readonly subject: string; readonly address: string; readonly path: string; readonly right: GrantRight }): boolean =>
    grant.subject === need.subject && addressCovers(grant.address, need.address) && grant.rights.includes(need.right) && isWithinPrefix(grant.prefix, need.path);

/** Who is asking, and the grant they present: the owner of an address needs none for it */
export interface Access {
    readonly subject: string;
    readonly grant?: string;
}

/**
 * Whether an access may use a right at a path of an address: the owner always, anyone else with a grant that checks
 * and allows it. Answers when the right lapses (the grant's expiry; Infinity for the owner) and the grant ids it rests on
 */
export const checkAccess = (access: Access | undefined, need: { readonly address: string; readonly path: string; readonly right: GrantRight }, context: GrantContext): { ok: true; expires: number; chain: readonly string[] } | { ok: false; reason: string } => {
    if (access !== undefined && access.subject === ownerOfAddress(need.address)) {
        return { ok: true, expires: Number.POSITIVE_INFINITY, chain: [] };
    }
    if (access?.grant === undefined) {
        return { ok: false, reason: `a ${need.right} of ${need.address} needs a grant` };
    }
    const checked = verifyGrant(access.grant, context);
    if (!checked.ok) {
        return checked;
    }
    if (!grantAllows(checked.grant, { subject: access.subject, ...need })) {
        return { ok: false, reason: `the grant does not let ${access.subject} ${need.right} ${need.path} of ${need.address}` };
    }
    return { ok: true, expires: checked.grant.expires, chain: checked.chain };
};

/** Revoked grant ids, each kept until the grant would have expired */
export class RevocationList {
    private readonly revoked = new Map<string, number>();

    add(grantId: string, expires: number): void {
        this.revoked.set(grantId, Math.max(expires, this.revoked.get(grantId) ?? 0));
    }

    has(grantId: string): boolean {
        return this.revoked.has(grantId);
    }

    /** Forgets the ids whose grants have expired by now */
    prune(now: number): void {
        for (const [id, expires] of this.revoked) {
            if (expires <= now) {
                this.revoked.delete(id);
            }
        }
    }

    get size(): number {
        return this.revoked.size;
    }
}

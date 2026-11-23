import { createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import type { KeyObject } from "node:crypto";
import { compilePattern, pathSteps, patternContains, patternCovers, stepAdmits, type PathPattern } from "@punyts/state";

/** What a grant lets its subject do under its pattern */
export type GrantRight = "read" | "write";

/**
 * A right to read or write the paths a pattern covers under one owner (docs/design/statenet-permissions.md, "Tokens"),
 * signed by its issuer's key. It is made from a permission entry and names it, so revoking the entry ends it. A grant
 * the owner issues is a root; one a subject passes on embeds the grant it came from as `parent`, and may only narrow it
 */
export interface GrantClaims {
    /** The permission entry it was made from: what a revocation names */
    readonly entry: string;
    /** The id of the key that signed it */
    readonly kid: string;
    /** Who gave it: the owner for a root, the subject of `parent` for one passed on */
    readonly issuer: string;
    /** Who may use it: a person, an org or a node */
    readonly subject: string;
    /** The owner whose tree it is in: the `$` of its pattern */
    readonly owner: string;
    /** The path pattern it covers, with everything below each match: `$`, `$.apps.a1`, `$.apps.*.files`, `$.data.{set}` */
    readonly pattern: string;
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
    /** Whether an entry was revoked */
    readonly revoked?: (entry: string) => boolean;
}

export type GrantCheck =
    | { readonly ok: true; readonly grant: GrantClaims; readonly chain: readonly string[] }
    | { readonly ok: false; readonly reason: string };

/** The most grants in one chain */
export const MAX_GRANT_DEPTH = 8;

const encode = (bytes: Uint8Array | string): string => Buffer.from(bytes).toString("base64url");
const decode = (text: string): Buffer => Buffer.from(text, "base64url");

/** The owner of an address: its first segment */
export const ownerOfAddress = (address: string): string => address.split("/")[0] ?? "";

/**
 * Where a path of a namespace is in its owner's tree: the address's segments after the owner lead to the namespace, so
 * `$.notes` of `alice/apps/a1` is `$.apps.a1.notes` of `alice`
 */
export const addressPath = (address: string, path: string): { readonly owner: string; readonly path: string } => {
    const [owner = "", ...base] = address.split("/");
    const steps = [...base, ...pathSteps(path)];
    return { owner, path: steps.length === 0 ? "$" : `$.${steps.join(".")}` };
};

/** A grant's pattern read: `$` is the whole tree; undefined when it is not a pattern */
export const grantPattern = (source: string): PathPattern | undefined => (source === "$" ? { source, steps: [] } : compilePattern(source));

/**
 * How far a pattern reaches at a path: `covers` when the path is at or below one of its matches, `below` when the path
 * is above a match (a read of it gets only what the pattern matches), `none` when it is beside every match
 */
export const patternReach = (pattern: PathPattern, path: string): "covers" | "below" | "none" => {
    if (patternCovers(pattern, path)) {
        return "covers";
    }
    const steps = pathSteps(path);
    return steps.length < pattern.steps.length && steps.every((step, index) => stepAdmits(pattern.steps[index] as PathPattern["steps"][number], step)) ? "below" : "none";
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
export const signGrant = (claims: Omit<GrantClaims, "entry"> & { entry?: string }, privateKey: string | KeyObject): string => {
    const full: GrantClaims = { ...claims, entry: claims.entry ?? randomUUID() };
    const body = encode(JSON.stringify(full));
    return `${body}.${encode(sign(null, Buffer.from(body), privateKeyOf(privateKey)))}`;
};

/** The claims of a token without checking it, or undefined when it is not one */
export const readGrant = (token: string): GrantClaims | undefined => {
    const [body] = token.split(".");
    try {
        const claims = JSON.parse(decode(body ?? "").toString("utf8")) as GrantClaims;
        return typeof claims === "object" && claims !== null && typeof claims.entry === "string" && typeof claims.owner === "string" && typeof claims.pattern === "string" ? claims : undefined;
    }
    catch {
        return undefined;
    }
};

/**
 * Checks a grant and the chain it came from: every signature by its issuer's key (a key retired before a grant was
 * issued does not count), the root issued by the owner, each grant passed on by the subject of the one before and no
 * wider than it (the same owner, a pattern it contains, rights among, an expiry no later), nothing expired, no entry
 * in the chain revoked. Answers the grant with the entries of its chain, root last
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
    const pattern = grantPattern(claims.pattern);
    if (pattern === undefined) {
        return { ok: false, reason: "not a pattern" };
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
    if (context.revoked?.(claims.entry) === true) {
        return { ok: false, reason: "revoked" };
    }
    if (claims.parent === undefined) {
        if (claims.issuer !== claims.owner) {
            return { ok: false, reason: "a grant must come from the owner, or be passed on from one that does" };
        }
        return { ok: true, grant: claims, chain: [claims.entry] };
    }
    const parent = verifyGrant(claims.parent, context, depth + 1);
    if (!parent.ok) {
        return parent;
    }
    const from = parent.grant;
    if (from.subject !== claims.issuer) {
        return { ok: false, reason: "passed on by someone the grant was not given to" };
    }
    if (from.owner !== claims.owner || !patternContains(grantPattern(from.pattern) as PathPattern, pattern) || !claims.rights.every((right) => from.rights.includes(right)) || claims.expires > from.expires) {
        return { ok: false, reason: "wider than the grant it was passed on from" };
    }
    return { ok: true, grant: claims, chain: [claims.entry, ...parent.chain] };
};

/** Who is asking, and the grant they present: the owner of an address needs none for it */
export interface Access {
    readonly subject: string;
    readonly grant?: string;
}

/** What `checkAccess` answers when the right holds */
export interface AccessAllowed {
    readonly ok: true;
    /** When the right lapses: the grant's expiry; Infinity for the owner */
    readonly expires: number;
    /** The entries the right rests on */
    readonly chain: readonly string[];
    /**
     * A read of a path above the grant's matches: the grant's pattern, in the owner's tree, which cuts what the reader
     * gets to the parts it matches (`cutTo`)
     */
    readonly cut?: PathPattern;
}

/**
 * Whether an access may use a right at a path of an address: the owner always, anyone else with a grant that checks,
 * is theirs, is for the address's owner, has the right, and whose pattern covers the path. A read of a path above the
 * pattern's matches is allowed too, cut to what the pattern matches; a write never is
 */
export const checkAccess = (access: Access | undefined, need: { readonly address: string; readonly path: string; readonly right: GrantRight }, context: GrantContext): AccessAllowed | { readonly ok: false; readonly reason: string } => {
    const at = addressPath(need.address, need.path);
    if (access !== undefined && access.subject === at.owner) {
        return { ok: true, expires: Number.POSITIVE_INFINITY, chain: [] };
    }
    if (access?.grant === undefined) {
        return { ok: false, reason: `a ${need.right} of ${need.address} needs a grant` };
    }
    const checked = verifyGrant(access.grant, context);
    if (!checked.ok) {
        return checked;
    }
    const { grant } = checked;
    const reach = grant.subject === access.subject && grant.owner === at.owner && grant.rights.includes(need.right) ? patternReach(grantPattern(grant.pattern) as PathPattern, at.path) : "none";
    if (reach === "none" || (reach === "below" && need.right !== "read")) {
        return { ok: false, reason: `the grant does not let ${access.subject} ${need.right} ${need.path} of ${need.address}` };
    }
    return { ok: true, expires: grant.expires, chain: checked.chain, ...(reach === "below" ? { cut: grantPattern(grant.pattern) as PathPattern } : {}) };
};

/** Revoked entries, each kept until the grants made from it would have expired */
export class RevocationList {
    private readonly revoked = new Map<string, number>();

    add(entry: string, expires: number): void {
        this.revoked.set(entry, Math.max(expires, this.revoked.get(entry) ?? 0));
    }

    has(entry: string): boolean {
        return this.revoked.has(entry);
    }

    /** Forgets the entries whose grants have expired by now */
    prune(now: number): void {
        for (const [entry, expires] of this.revoked) {
            if (expires <= now) {
                this.revoked.delete(entry);
            }
        }
    }

    get size(): number {
        return this.revoked.size;
    }
}

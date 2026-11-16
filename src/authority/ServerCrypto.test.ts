import { describe, expect, it, vi } from "vitest";
import { report } from "@punyts/core";
import { createAuthority } from "./Authority.js";
import { createMemoryNamespaceStorage, type NamespaceStorage, type StoredNamespace } from "./NamespaceStorage.js";
import { ENCRYPTED_PREFIX, decryptServerBranch, encryptServerBranch } from "./ServerCrypto.js";

vi.mock("@punyts/core", async (original) => ({ ...(await original<typeof import("@punyts/core")>()), report: vi.fn() }));

const NAMESPACE = "apps.vault";
const KEY = new Uint8Array(32).fill(1);
const OTHER_KEY = new Uint8Array(32).fill(2);
const SECRETS = Object.freeze({ apiKey: "sk-plaintext-secret", limits: Object.freeze({ daily: 5 }) });

/** Storage that also records the text of every save, as a file would hold it */
const recordingStorage = () => {
    const inner = createMemoryNamespaceStorage();
    const saved: string[] = [];
    const storage: NamespaceStorage = {
        load: inner.load,
        save: async (namespace, stored) => {
            saved.push(JSON.stringify(stored));
            await inner.save(namespace, stored);
        }
    };
    return { storage, saved };
};

const flipLastByte = (encrypted: string) => {
    const bytes = Buffer.from(encrypted.slice(ENCRYPTED_PREFIX.length), "base64");
    bytes[bytes.length - 1] ^= 1;
    return ENCRYPTED_PREFIX + bytes.toString("base64");
};

describe("ServerCrypto", () => {
    it("should round trip each $.server value", () => {
        const encrypted = encryptServerBranch(SECRETS, KEY, NAMESPACE);

        expect(Object.keys(encrypted)).toEqual(["apiKey", "limits"]);
        expect(encrypted.apiKey).toMatch(new RegExp(`^${ENCRYPTED_PREFIX}`));
        expect(decryptServerBranch(encrypted, KEY, NAMESPACE)).toEqual(SECRETS);
    });

    it("should use a fresh nonce for every encryption", () => {
        const first = encryptServerBranch(SECRETS, KEY, NAMESPACE);
        const second = encryptServerBranch(SECRETS, KEY, NAMESPACE);

        expect(first.apiKey).not.toBe(second.apiKey);
    });

    it("should refuse tampered ciphertext", () => {
        const encrypted = encryptServerBranch(SECRETS, KEY, NAMESPACE);

        expect(() => decryptServerBranch({ ...encrypted, apiKey: flipLastByte(encrypted.apiKey as string) }, KEY, NAMESPACE))
            .toThrow("Could not decrypt $.server.apiKey of apps.vault: wrong key or tampered data");
    });

    it("should refuse a wrong key, a value moved to another name and a value that is not encrypted", () => {
        const encrypted = encryptServerBranch(SECRETS, KEY, NAMESPACE);

        expect(() => decryptServerBranch(encrypted, OTHER_KEY, NAMESPACE)).toThrow("wrong key or tampered data");
        expect(() => decryptServerBranch({ token: encrypted.apiKey as string }, KEY, NAMESPACE)).toThrow("$.server.token");
        expect(() => decryptServerBranch(encrypted, KEY, "apps.other")).toThrow("wrong key or tampered data");
        expect(() => decryptServerBranch({ apiKey: "plain" }, KEY, NAMESPACE)).toThrow("it is not encrypted");
    });

    it("should refuse a key that is not 32 bytes", () => {
        expect(() => encryptServerBranch(SECRETS, new Uint8Array(16), NAMESPACE)).toThrow("must be 32 bytes, not 16");
    });
});

describe("authority $.server at rest", () => {
    it("should save $.server encrypted, with no plaintext and no key, and load it back", async () => {
        const { storage, saved } = recordingStorage();
        const authority = await createAuthority({ namespace: NAMESPACE, storage, serverKey: KEY, initial: { data: {}, server: { ...SECRETS } } });

        authority.write({ path: "$.server.token", op: "set", value: "tok-plaintext-secret" });
        await authority.flush();
        const loaded = await createAuthority({ namespace: NAMESPACE, storage, serverKey: KEY });

        const text = saved.join("\n");
        expect(text).not.toContain("plaintext-secret");
        expect(text).not.toContain(Buffer.from(KEY).toString("base64"));
        expect(text).not.toContain(Buffer.from(KEY).toString("hex"));
        expect(loaded.state()).toEqual({ data: {}, server: { ...SECRETS, token: "tok-plaintext-secret" } });
    });

    it("should fail to load with a wrong key or tampered data instead of loading garbage", async () => {
        const { storage } = recordingStorage();
        const authority = await createAuthority({ namespace: NAMESPACE, storage, serverKey: KEY, initial: { server: { ...SECRETS } } });
        authority.write({ path: "$.server.token", op: "set", value: "t" });
        await authority.flush();
        const stored = (await storage.load(NAMESPACE)) as StoredNamespace;
        const server = stored.state.server as { [name: string]: string };
        const tampered = createMemoryNamespaceStorage();
        await tampered.save(NAMESPACE, { ...stored, state: { ...stored.state, server: { ...server, token: flipLastByte(server.token as string) } } });

        await expect(createAuthority({ namespace: NAMESPACE, storage, serverKey: OTHER_KEY })).rejects.toThrow("Could not decrypt $.server.");
        await expect(createAuthority({ namespace: NAMESPACE, storage: tampered, serverKey: KEY })).rejects.toThrow("$.server.token of apps.vault: wrong key or tampered data");
    });

    it("should keep no $.server without a key", async () => {
        const { storage } = recordingStorage();
        const keyed = await createAuthority({ namespace: NAMESPACE, storage, serverKey: KEY, initial: { server: { ...SECRETS } } });
        keyed.write({ path: "$.server.token", op: "set", value: "t" });
        await keyed.flush();
        const keyless = await createAuthority({ namespace: "apps.plain", storage: createMemoryNamespaceStorage() });

        await expect(createAuthority({ namespace: NAMESPACE, storage })).rejects.toThrow("has $.server, but the authority has no serverKey");
        await expect(createAuthority({ namespace: "apps.new", storage: createMemoryNamespaceStorage(), initial: { server: {} } })).rejects.toThrow("no serverKey");
        expect(() => keyless.write({ path: "$.server.token", op: "set", value: "t" })).toThrow("needs a serverKey");
    });

    it("should refuse a $.server that is not an object of named values", async () => {
        const authority = await createAuthority({ namespace: NAMESPACE, storage: createMemoryNamespaceStorage(), serverKey: KEY });

        expect(() => authority.write({ path: "$.server", op: "set", value: ["a"] })).toThrow("must be an object of named values");
        expect(authority.write({ path: "$.server", op: "set", value: { a: 1 } })).toBeUndefined();
    });

    it("should never report the key or a secret from the authority", async () => {
        const failing: NamespaceStorage = { load: async () => undefined, save: async () => { throw new Error("disk full"); } };
        const authority = await createAuthority({ namespace: NAMESPACE, storage: failing, serverKey: KEY, initial: { server: { ...SECRETS } } });

        authority.write({ path: "$.server.token", op: "set", value: "tok-plaintext-secret" });
        await authority.flush();

        //@punyts/state's own debug reports are its business; the authority's are checked here
        const reported = JSON.stringify(vi.mocked(report).mock.calls.filter(([channel]) => channel === "state-sync"));
        expect(reported).toContain("disk full");
        expect(reported).not.toContain("plaintext-secret");
        expect(reported).not.toContain(Buffer.from(KEY).toString("base64"));
    });
});

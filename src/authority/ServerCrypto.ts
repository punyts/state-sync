/// <reference types="node" />
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { JsonValue } from "../Change.js";

/** The prefix of an encrypted $.server value as it is stored */
export const ENCRYPTED_PREFIX = "punyts-enc:v1:";

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The branch of a stored state that holds the server-only values */
type ServerBranch = { [name: string]: JsonValue };

const checkKey = (key: Uint8Array) => {
    if (key.length !== KEY_BYTES) {
        throw new Error(`The server key must be ${KEY_BYTES} bytes, not ${key.length}`);
    }
};

/**
 * Encrypts each direct child of $.server with AES-256-GCM and a fresh nonce; the namespace and the child's name are
 * the additional data, so a value moved to another name or namespace does not decrypt
 * @param server
 * @param key 32 bytes
 * @param namespace
 */
export const encryptServerBranch = (server: ServerBranch, key: Uint8Array, namespace: string): ServerBranch => {
    checkKey(key);
    const encrypted: ServerBranch = {};
    for (const [name, value] of Object.entries(server)) {
        const nonce = randomBytes(NONCE_BYTES);
        const cipher = createCipheriv("aes-256-gcm", key, nonce);
        cipher.setAAD(Buffer.from(`${namespace}:${name}`, "utf8"));
        const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
        encrypted[name] = ENCRYPTED_PREFIX + Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString("base64");
    }
    return encrypted;
};

/**
 * Decrypts each direct child of a stored $.server. Throws for a wrong key, tampered data or a value that is not
 * encrypted, naming the child but never the key or the value
 * @param server
 * @param key 32 bytes
 * @param namespace
 */
export const decryptServerBranch = (server: ServerBranch, key: Uint8Array, namespace: string): ServerBranch => {
    checkKey(key);
    const decrypted: ServerBranch = {};
    for (const [name, value] of Object.entries(server)) {
        const failed = (reason: string) => new Error(`Could not decrypt $.server.${name} of ${namespace}: ${reason}`);
        if (typeof value !== "string" || !value.startsWith(ENCRYPTED_PREFIX)) {
            throw failed("it is not encrypted");
        }
        const bytes = Buffer.from(value.slice(ENCRYPTED_PREFIX.length), "base64");
        if (bytes.length < NONCE_BYTES + TAG_BYTES) {
            throw failed("wrong key or tampered data");
        }
        try {
            const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, NONCE_BYTES));
            decipher.setAAD(Buffer.from(`${namespace}:${name}`, "utf8"));
            decipher.setAuthTag(bytes.subarray(bytes.length - TAG_BYTES));
            const plaintext = Buffer.concat([decipher.update(bytes.subarray(NONCE_BYTES, bytes.length - TAG_BYTES)), decipher.final()]);
            decrypted[name] = JSON.parse(plaintext.toString("utf8")) as JsonValue;
        }
        catch {
            throw failed("wrong key or tampered data");
        }
    }
    return decrypted;
};

/**
 * A random version 4 UUID. `crypto.randomUUID` exists only in a secure context (HTTPS or localhost), so a page served
 * over plain HTTP on a network address builds one from `crypto.getRandomValues`, which every context has.
 */
export const randomId = (): string => {
    const crypto = globalThis.crypto;
    if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
    bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

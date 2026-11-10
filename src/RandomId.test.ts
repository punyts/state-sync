import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "./RandomId.js";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("randomId", () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it("should use crypto.randomUUID when the context has it", () => {
        // Act
        const id = randomId();

        // Assert
        expect(id).toMatch(UUID_V4);
    });

    it("should make a version 4 UUID from getRandomValues on a page that is not a secure context", () => {
        // Arrange
        const getRandomValues = globalThis.crypto.getRandomValues.bind(globalThis.crypto);
        vi.stubGlobal("crypto", { getRandomValues });

        // Act
        const ids = new Set(Array.from({ length: 50 }, () => randomId()));

        // Assert
        expect(ids.size).toBe(50);
        for (const id of ids) expect(id).toMatch(UUID_V4);
    });
});

import { describe, expect, it } from "vitest";
import { isAtOrBelow, isSyncPath } from "./Paths.js";

describe("isSyncPath", () => {
    it("should accept a path below the root", () => {
        expect(isSyncPath("$.data.orders.k42.total")).toBe(true);
        expect(isSyncPath("$.app.view")).toBe(true);
        expect(isSyncPath("$.data.list.0")).toBe(true);
    });

    it("should accept a path at or below $.server", () => {
        expect(isSyncPath("$.server")).toBe(true);
        expect(isSyncPath("$.server.keys.api")).toBe(true);
    });

    it("should refuse the root and a path without the $. prefix", () => {
        expect(isSyncPath("$")).toBe(false);
        expect(isSyncPath("data.total")).toBe(false);
        expect(isSyncPath("")).toBe(false);
    });

    it("should refuse a path at or below $.runtime", () => {
        expect(isSyncPath("$.runtime")).toBe(false);
        expect(isSyncPath("$.runtime.empty")).toBe(false);
    });

    it("should accept a path that only starts like $.runtime", () => {
        expect(isSyncPath("$.runtimes")).toBe(true);
    });

    it("should refuse a malformed path", () => {
        expect(isSyncPath("$.data..total")).toBe(false);
        expect(isSyncPath("$.data.")).toBe(false);
        expect(isSyncPath("$.data total")).toBe(false);
    });

    it("should refuse a wildcard segment", () => {
        expect(isSyncPath("$.data.$all")).toBe(false);
        expect(isSyncPath("$.$every.x")).toBe(false);
    });

    it("should refuse a segment that reaches a prototype", () => {
        expect(isSyncPath("$.data.__proto__.x")).toBe(false);
        expect(isSyncPath("$.data.constructor")).toBe(false);
        expect(isSyncPath("$.data.prototype")).toBe(false);
    });
});

describe("isAtOrBelow", () => {
    it("should be true for the branch and the paths below it only", () => {
        expect(isAtOrBelow("$.server", "$.server")).toBe(true);
        expect(isAtOrBelow("$.server.a", "$.server")).toBe(true);
        expect(isAtOrBelow("$.servers", "$.server")).toBe(false);
        expect(isAtOrBelow("$", "$.server")).toBe(false);
    });
});

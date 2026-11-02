import { describe, expect, it } from "vitest";
import { touchesPattern } from "./Patterns.js";

describe("touchesPattern", () => {
    it("should match a path a wildcard segment covers", () => {
        expect(touchesPattern("$.data.expenses.*", "$.data.expenses.3")).toBe(true);
        expect(touchesPattern("$.data.*.total", "$.data.orders.total")).toBe(true);
    });

    it("should match a change below or above a matched path", () => {
        expect(touchesPattern("$.data.expenses.*", "$.data.expenses.3.amount")).toBe(true);
        expect(touchesPattern("$.data.expenses.*", "$.data.expenses")).toBe(true);
        expect(touchesPattern("$.data.expenses.*", "$.data")).toBe(true);
    });

    it("should not match another branch", () => {
        expect(touchesPattern("$.data.expenses.*", "$.data.income.3")).toBe(false);
        expect(touchesPattern("$.data.*.total", "$.data.orders.count")).toBe(false);
        expect(touchesPattern("$.data.expenses", "$.app.page")).toBe(false);
    });
});

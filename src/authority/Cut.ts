import { pathSteps, stepAdmits, type PathPattern, type PatternStep } from "@punyts/state";
import type { JsonValue, RevisedChange } from "../Change.js";

/**
 * What a reader whose grant reaches only part of a namespace gets of it (docs/design/statenet-permissions.md, "Tokens"):
 * the parts of values and changes its pattern matches, in the namespace's own paths
 */
export interface Cut {
    /** The change as the reader sees it, or undefined when it touches nothing the pattern matches */
    change(change: RevisedChange): RevisedChange | undefined;
    /** The value at a path, cut to what the pattern matches under it */
    value(path: string, value: JsonValue | undefined): JsonValue | undefined;
}

type JsonObject = { [key: string]: JsonValue };

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/** The parts of a value the remaining steps of a pattern match; undefined when the value has no keys to follow */
const pick = (steps: readonly PatternStep[], value: JsonValue | undefined): JsonValue | undefined => {
    if (steps.length === 0) {
        return value;
    }
    if (!isObject(value)) {
        return undefined;
    }
    const [first, ...rest] = steps as [PatternStep, ...PatternStep[]];
    const picked: JsonObject = {};
    for (const [key, inner] of Object.entries(value)) {
        if (stepAdmits(first, key)) {
            const part = pick(rest, inner);
            if (part !== undefined) {
                picked[key] = part;
            }
        }
    }
    return picked;
};

/**
 * The cut of a grant's pattern (in its owner's tree) for one namespace at an address: the address's segments after
 * the owner are the pattern's first steps, and the rest is matched against the namespace's paths. A change below a
 * match passes whole; a change above one passes as the parts the pattern matches (a `delete` whole, a `set` or
 * `replace` of nothing matched as a `delete`, a `merge` with each key it writes cut, `{}` for a key with nothing
 * matched under it); any other change is dropped
 */
export const cutTo = (address: string, pattern: PathPattern): Cut => {
    const base = address.split("/").slice(1);
    const steps = pattern.steps.slice(base.length);
    const fits = (path: readonly string[]) => path.every((key, index) => index >= steps.length || stepAdmits(steps[index] as PatternStep, key));
    return {
        change: (change) => {
            const path = pathSteps(change.path);
            if (!fits(path)) {
                return undefined;
            }
            if (path.length >= steps.length || change.op === "delete") {
                return change;
            }
            const rest = steps.slice(path.length);
            if (change.op === "merge") {
                if (!isObject(change.value)) {
                    return undefined;
                }
                const [first, ...below] = rest as [PatternStep, ...PatternStep[]];
                const merged: JsonObject = {};
                for (const [key, inner] of Object.entries(change.value)) {
                    if (stepAdmits(first, key)) {
                        merged[key] = pick(below, inner) ?? {};
                    }
                }
                return Object.keys(merged).length === 0 ? undefined : { ...change, value: merged };
            }
            const value = pick(rest, change.value);
            if (value === undefined) {
                return { id: change.id, path: change.path, op: "delete", base: change.base, revision: change.revision, ...(change.ephemeral === true ? { ephemeral: true as const } : {}) };
            }
            return { ...change, value };
        },
        value: (path, value) => {
            const at = pathSteps(path);
            return fits(at) ? pick(steps.slice(at.length), value) : undefined;
        }
    };
};

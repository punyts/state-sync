import { validatePath } from "@punyts/state";

/** The branch of a store that never syncs: the runtime state of the page */
export const RUNTIME_PATH = "$.runtime";

/** The server-only branch: it syncs between an app server and the statenet, never to a browser */
export const SERVER_PATH = "$.server";

//segments that would reach the prototype of an object when a change is applied
const UNSAFE_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * True when the path is the branch path itself or a path below it
 * @param path - a "$."-prefixed path
 * @param branch - a "$."-prefixed path
 */
export const isAtOrBelow = (path: string, branch: string): boolean =>
    path === branch || path.startsWith(`${branch}.`);

/**
 * True when the path can be the path of a change: a valid "$."-prefixed store path that is not the root, has no
 * wildcard and no unsafe segment, and is not at or below "$.runtime". "$.server" paths are valid; capture and the
 * authority keep them from browsers.
 * @param path
 */
export const isSyncPath = (path: string): boolean => {
    if (!path.startsWith("$.") || !validatePath(path)) {
        return false;
    }
    const segments = path.split(".");
    for (let index = 1; index < segments.length; index++) {
        const segment = segments[index];
        if (segment.startsWith("$") || UNSAFE_SEGMENTS.has(segment)) {
            return false;
        }
    }
    return !isAtOrBelow(path, RUNTIME_PATH);
};

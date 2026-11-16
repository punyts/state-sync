/**
 * True when a change at the path touches a path the pattern matches: the change is at such a path, below one, or above
 * one (a change above replaces what is below it). A "*" segment of the pattern matches any one segment.
 * @param pattern - a "$."-prefixed path that may hold "*" segments, such as "$.data.expenses.*"
 * @param path - the "$."-prefixed path of a change
 */
/**
 * True when the path is at or below a path the pattern matches ("*" matches any one segment): a change there writes
 * only what the pattern covers
 * @param pattern - a "$."-prefixed path that may hold "*" segments, such as "$.presence.*"
 * @param path - a "$."-prefixed path
 */
export const isWithinPattern = (pattern: string, path: string): boolean => {
    const patternSegments = pattern.split(".");
    const pathSegments = path.split(".");
    return patternSegments.length <= pathSegments.length && patternSegments.every((segment, index) => segment === "*" || segment === pathSegments[index]);
};

export const touchesPattern = (pattern: string, path: string): boolean => {
    const patternSegments = pattern.split(".");
    const pathSegments = path.split(".");
    const length = Math.min(patternSegments.length, pathSegments.length);
    for (let index = 0; index < length; index++) {
        if (patternSegments[index] !== "*" && patternSegments[index] !== pathSegments[index]) {
            return false;
        }
    }
    return true;
};

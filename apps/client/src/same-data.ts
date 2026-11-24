/**
 * Whether two pieces of plain data, as a tile is, say the same. With
 * `functionsAlike`, any two functions count as the same: for data that
 * carries callbacks made from what is compared, such as a room's lights
 * button, whose press switches the lights compared beside it.
 */
export function sameData(
  a: unknown,
  b: unknown,
  { functionsAlike = false } = {},
): boolean {
  if (Object.is(a, b)) return true;
  if (functionsAlike && typeof a === "function" && typeof b === "function")
    return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) =>
      Object.hasOwn(b, key) &&
      sameData(
        (a as Record<string, unknown>)[key],
        (b as Record<string, unknown>)[key],
        { functionsAlike },
      ),
  );
}

/** Whether two lists hold the very same items, in the same order. */
export const sameItems = (a: readonly unknown[], b: readonly unknown[]) =>
  a.length === b.length && a.every((item, index) => item === b[index]);

/**
 * A limit on how often one key gets through: `max` times in any `windowMs`,
 * counted in this process's memory. `allows` counts the try it lets through.
 */
export function createLimit(max: number, windowMs: number) {
  const tries = new Map<string, number[]>();
  // Past this many keys the quiet ones are forgotten. If that frees nothing,
  // a key not seen yet is refused: forgetting the others instead would hand
  // each of them its tries back, so a flood of keys would lift the limit.
  const mostKeys = 10_000;

  return function allows(key: string, now = Date.now()) {
    const since = now - windowMs;
    if (tries.size >= mostKeys && !tries.has(key)) {
      for (const [other, times] of tries) {
        if ((times.at(-1) ?? 0) <= since) tries.delete(other);
      }
      if (tries.size >= mostKeys) return false;
    }
    const recent = (tries.get(key) ?? []).filter((time) => time > since);
    const allowed = recent.length < max;
    if (allowed) recent.push(now);
    tries.set(key, recent);
    return allowed;
  };
}

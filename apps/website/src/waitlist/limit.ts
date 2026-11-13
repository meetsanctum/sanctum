/**
 * A limit on how often one key gets through: `max` times in any `windowMs`,
 * counted in this process's memory. `allows` counts the try it lets through.
 */
export function createLimit(max: number, windowMs: number) {
  const tries = new Map<string, number[]>();
  // Past this many keys the quiet ones are forgotten, and all of them if
  // that frees nothing, so a flood of keys cannot fill the memory.
  const mostKeys = 10_000;

  return function allows(key: string, now = Date.now()) {
    const since = now - windowMs;
    if (tries.size >= mostKeys) {
      for (const [other, times] of tries) {
        if ((times.at(-1) ?? 0) <= since) tries.delete(other);
      }
      if (tries.size >= mostKeys) tries.clear();
    }
    const recent = (tries.get(key) ?? []).filter((time) => time > since);
    const allowed = recent.length < max;
    if (allowed) recent.push(now);
    tries.set(key, recent);
    return allowed;
  };
}

// How workflows read a media player. One that loads in the middle of a
// film is still playing, so "starts playing" does not fire again as it
// carries on, and "is playing" holds while it buffers. Pause and Resume on a
// player with nothing to pause or resume send nothing: pausing a TV that
// isn't playing would go unanswered each time the doorbell rang.

/** A capability's state as triggers and conditions compare it. */
export function comparedState(kind: string, state: unknown): unknown {
  if (
    kind !== "media" ||
    !state ||
    typeof state !== "object" ||
    (state as { activity?: unknown }).activity !== "loading"
  ) {
    return state;
  }
  return { ...state, activity: "playing" };
}

/**
 * Why a step's command has nothing to act on, for its run's history, or
 * undefined when it does.
 */
export function nothingToDo(
  kind: string,
  command: Record<string, unknown>,
  state: unknown,
): string | undefined {
  if (kind !== "media" || !state || typeof state !== "object") {
    return undefined;
  }
  const { activity } = comparedState(kind, state) as { activity?: unknown };
  if (command.activity === "paused" && activity !== "playing") {
    return "Nothing was playing";
  }
  if (command.activity === "playing" && activity !== "paused") {
    return activity === "playing" ? "It was playing" : "Nothing was paused";
  }
  return undefined;
}

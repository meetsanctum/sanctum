import type { StaticManifest } from "./index.js";

// An app's contract: what its committed sanctum-app.json promises the core,
// workflows and dashboards. Taking away or renaming an action, event,
// setting, entity type, widget, room section or workflow piece breaks what
// was built on it, so it needs a new major version.

// What other things may depend on, by kind: the ids of its actions,
// events, entity types, widgets, room sections and workflow pieces, and the
// names of its settings.
function promises(manifest: Partial<Record<string, unknown>>) {
  const ids = (list: unknown) =>
    Array.isArray(list)
      ? list.flatMap((each) =>
          typeof each?.id === "string" ? [each.id as string] : [],
        )
      : [];
  const settings = manifest.settings as
    { properties?: Record<string, unknown> } | null | undefined;
  const provides = manifest.provides as
    Partial<Record<string, unknown>> | null | undefined;
  return {
    action: ids(manifest.actions),
    event: ids(manifest.events),
    entity: ids(provides?.entities),
    widget: ids(provides?.widgets),
    roomSection: ids(provides?.roomSections),
    devicePage: ids(provides?.devicePages),
    setting: Object.keys(settings?.properties ?? {}),
    trigger: ids(provides?.triggers),
    condition: ids(provides?.conditions),
    step: ids(provides?.steps),
  };
}

/**
 * The version a breaking change has to raise: the major, or below 1.0 the
 * minor, as npm's caret ranges read it (^0.1.0 takes 0.1.x only).
 */
export function compatibleLine(version: string) {
  const [major = "0", minor = "0", patch = "0"] = version
    .split(/[-+]/)[0]!
    .split(".");
  if (major !== "0") return major;
  return minor !== "0" ? `0.${minor}` : `0.0.${patch}`;
}

function hasLaterCompatibilityLine(earlier: string, next: string) {
  const before = compatibleLine(earlier).split(".").map(Number);
  const after = compatibleLine(next).split(".").map(Number);
  for (let index = 0; index < 3; index++) {
    const previous = before[index] ?? 0;
    const current = after[index] ?? 0;
    if (current !== previous) return current > previous;
  }
  return false;
}

/** What a new manifest takes away from an earlier one, whatever its version. */
function takenAway(
  earlier: Partial<StaticManifest>,
  next: Partial<StaticManifest>,
) {
  const before = promises(earlier);
  const after = promises(next);
  return (Object.keys(before) as (keyof typeof before)[]).flatMap((kind) =>
    before[kind]
      .filter((id) => !after[kind].includes(id))
      .map((id) => `${kind} ${id}`),
  );
}

/**
 * What a new manifest takes away from an earlier one, such as
 * "action moods.runMood", or nothing when it keeps every promise or starts
 * a new major version.
 */
export function brokenPromises(
  earlier: Partial<StaticManifest> & { version: string },
  next: Partial<StaticManifest> & { version: string },
): string[] {
  return hasLaterCompatibilityLine(earlier.version, next.version)
    ? []
    : takenAway(earlier, next);
}

/**
 * A new manifest with the oldest of the app's pages that still work with it.
 * A version that takes something away raises that to itself, since pages
 * from before could use what's gone; otherwise it stays.
 */
export function withOldestPage(
  next: StaticManifest,
  earlier: StaticManifest | undefined,
): StaticManifest {
  if (!earlier) return next;
  const oldestPage =
    takenAway(earlier, next).length > 0 ? next.version : earlier.oldestPage;
  return oldestPage ? { ...next, oldestPage } : next;
}

const numbersOf = (version: string) =>
  version.split(/[-+]/)[0]!.split(".").map(Number);

/** Whether a version comes before another, by its numbers alone. */
export function isOlderVersion(version: string, than: string) {
  const [one, other] = [numbersOf(version), numbersOf(than)];
  for (let index = 0; index < 3; index++) {
    const difference = (one[index] ?? 0) - (other[index] ?? 0);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

/** The snapshot as it is committed: stable, two-space JSON with a final newline. */
export const snapshotText = (manifest: StaticManifest) =>
  `${JSON.stringify(manifest, null, 2)}\n`;

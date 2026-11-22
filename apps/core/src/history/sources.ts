import { historyFields, type CapabilityKind } from "@meetsanctum/app-sdk";

// The state fields a kind's history comes from, where they are not its
// history fields themselves: a media player's `playing` is whether its
// activity is playing. History keeps only these of a media player, so it
// knows when it played and was on, never what it played or how loud.
const sources: Partial<Record<CapabilityKind, readonly string[]>> = {
  media: ["on", "activity"],
};

/** The state fields whose change is a change in a capability's history. */
export function historySourcesOf(kind: CapabilityKind): readonly string[] {
  return sources[kind] ?? historyFields[kind];
}

/** What history keeps of a reported state. */
export function recordedState(
  kind: CapabilityKind,
  state: Record<string, unknown> | null,
): Record<string, unknown> | null {
  const fields = sources[kind];
  if (!fields || !state) return state;
  return Object.fromEntries(
    fields.flatMap((field) =>
      field in state ? [[field, state[field]] as const] : [],
    ),
  );
}

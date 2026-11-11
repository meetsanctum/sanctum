import type {
  Availability,
  CapabilityKind,
  HistoryField,
} from "@meetsanctum/app-sdk";

// History's roll-ups, ported from v1's recorder: each value of a capability
// over 5 minutes, and the hour from its twelve 5 minutes, as a mean with its
// least and greatest. v1 averaged the reports within a period and so had to
// record unchanged ones too; a light reports only when it changes, so here a
// value holds from one change to the next and the mean is weighed by how
// long it held.

/** A value from `at` until the next sample; null while it is not known. */
export type Sample = { at: number; value: number | null };

export type Rollup = {
  mean: number;
  min: number;
  max: number;
  // How long the value was known.
  seconds: number;
};

/** What a capability was: whether its device answered, and what it reported. */
export type Recorded = {
  availability: Availability;
  state: Record<string, unknown> | null;
};

// What each kind's values are in one recorded state: nothing is known of a
// device that does not answer, and a light's brightness counts only while
// it is on. A button has no state, so it records nothing; a sensor records
// its reading, and a motion sensor whether it saw someone.
const values: {
  [K in CapabilityKind]:
    | ((recorded: Recorded) => Partial<Record<HistoryField, number | null>>)
    | null;
} = {
  light: ({ availability, state }) => {
    const on = known(availability, state) ? (state.on === true ? 1 : 0) : null;
    return {
      on,
      brightness:
        on === 1 && typeof state?.brightness === "number"
          ? state.brightness
          : null,
    };
  },
  switch: ({ availability, state }) => ({
    on: known(availability, state) ? (state.on === true ? 1 : 0) : null,
  }),
  button: null,
  sensor: ({ availability, state }) => ({
    value:
      known(availability, state) && typeof state.value === "number"
        ? state.value
        : null,
  }),
  occupancy: ({ availability, state }) => ({
    occupied: known(availability, state)
      ? state.occupied === true
        ? 1
        : 0
      : null,
  }),
};

function known(
  availability: Availability,
  state: Record<string, unknown> | null,
): state is Record<string, unknown> {
  return availability !== "offline" && state !== null;
}

/** Whether history records a capability of this kind. */
export const isRecorded = (kind: CapabilityKind) => values[kind] !== null;

/** Each value of a kind, field by field, over recorded states in order. */
export function samplesOf(
  kind: CapabilityKind,
  states: readonly (Recorded & { at: number })[],
): Map<HistoryField, Sample[]> {
  const fields = new Map<HistoryField, Sample[]>();
  const valuesOf = values[kind];
  if (!valuesOf) return fields;
  for (const recorded of states) {
    for (const [field, value] of Object.entries(valuesOf(recorded))) {
      const samples = fields.get(field as HistoryField) ?? [];
      samples.push({ at: recorded.at, value });
      fields.set(field as HistoryField, samples);
    }
  }
  return fields;
}

/**
 * The roll-up of each period of `periodMs` from `from` until `to`, by its
 * start, from samples in order. The first may be before `from`, carrying
 * the value in, and the last holds until `to`. A period in which the value
 * was never known has none.
 */
export function rollUps(
  samples: readonly Sample[],
  from: number,
  to: number,
  periodMs: number,
): Map<number, Rollup> {
  const sums = new Map<
    number,
    { weighted: number; ms: number; min: number; max: number }
  >();
  for (const [index, sample] of samples.entries()) {
    const value = sample.value;
    if (value === null) continue;
    let at = Math.max(sample.at, from);
    const until = Math.min(samples[index + 1]?.at ?? to, to);
    while (at < until) {
      const start = from + Math.floor((at - from) / periodMs) * periodMs;
      const end = Math.min(start + periodMs, until);
      const sum = sums.get(start) ?? {
        weighted: 0,
        ms: 0,
        min: value,
        max: value,
      };
      sum.weighted += value * (end - at);
      sum.ms += end - at;
      sum.min = Math.min(sum.min, value);
      sum.max = Math.max(sum.max, value);
      sums.set(start, sum);
      at = end;
    }
  }
  const rollups = new Map<number, Rollup>();
  for (const [start, sum] of sums) {
    rollups.set(start, {
      mean: sum.weighted / sum.ms,
      min: sum.min,
      max: sum.max,
      seconds: Math.round(sum.ms / 1000),
    });
  }
  return rollups;
}

/** One roll-up of several, such as an hour's from its 5 minutes, weighed by how long each was known. */
export function combine(rollups: readonly Rollup[]): Rollup | null {
  const counted = rollups.filter((rollup) => rollup.seconds > 0);
  const seconds = counted.reduce((sum, rollup) => sum + rollup.seconds, 0);
  if (seconds === 0) return null;
  return {
    mean:
      counted.reduce((sum, rollup) => sum + rollup.mean * rollup.seconds, 0) /
      seconds,
    min: Math.min(...counted.map((rollup) => rollup.min)),
    max: Math.max(...counted.map((rollup) => rollup.max)),
    seconds,
  };
}

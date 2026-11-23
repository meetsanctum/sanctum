import { ActionError } from "@meetsanctum/app-sdk";
import {
  EntityCategory,
  entityId,
  type Entity,
  type TelemetryEvent,
} from "esphome-client";

import type { Session } from "./connection.js";
import { ringColourDistance, ringRgb } from "./ring-colour.js";
import { hasVoiceAssistant } from "./registration.js";

// A smart speaker's own parts, which only ESPHome's page shows: its
// microphones, the Mute switch its firmware has, and its ring, the LED Ring
// light. The ring is never a light in the home: its colour and brightness
// are those of every animation the speaker shows as it listens and
// answers, the speaker's look rather than a lamp. The Home Assistant Voice
// PE's firmware names both so, as settings of its own.

/** A smart speaker's own parts, by their entities, where it has them. */
export type SpeakerParts = { mute: Entity | null; ring: Entity | null };

export type SpeakerSettings = {
  /** Whether its microphones are on, unknown until it says. */
  microphones: boolean | null;
  /** Its ring, unknown until it says. */
  ring: Ring | null;
};

/** What a smart speaker's page shows of it. */
export type SpeakerState = SpeakerSettings & {
  heardWakeWordAt: number | null;
};

export type Ring = {
  /** Whether it glows while it waits, besides while it's busy. */
  glow: boolean;
  /** Its colour, as #rrggbb. */
  colour: string;
  /** Its brightness, in percent. */
  brightness: number;
};

/** A change to a smart speaker's parts, each left as it is where unsaid. */
export type SpeakerChange = {
  microphones?: boolean;
  ring?: Partial<Ring>;
};

/** A smart speaker's own parts, or null for a device that isn't one. */
export function speakerPartsOf(
  session: Pick<Session, "info" | "entities">,
): SpeakerParts | null {
  if (!hasVoiceAssistant(session.info)) return null;
  const own = (type: string, objectId: string) =>
    session.entities.find(
      (each) =>
        each.type === type &&
        each.objectId === objectId &&
        each.entityCategory === EntityCategory.CONFIG,
    ) ?? null;
  const parts = { mute: own("switch", "mute"), ring: own("light", "led_ring") };
  return parts;
}

const hex = (value: number) =>
  Math.round(unit(value) * 255)
    .toString(16)
    .padStart(2, "0");

function unit(value: number) {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function ringOf(event: TelemetryEvent & { type: "light" }): Ring {
  return {
    glow: event.state === true,
    colour: `#${hex(event.red ?? 0)}${hex(event.green ?? 0)}${hex(event.blue ?? 0)}`,
    brightness: Math.round(unit(event.brightness ?? 0) * 100),
  };
}

export function speakerSettingsOf(
  { client }: Session,
  { mute, ring }: SpeakerParts,
): SpeakerSettings {
  const switches = mute && client.latest(entityId("switch", mute.objectId));
  const lights = ring && client.latest(entityId("light", ring.objectId));
  return {
    microphones: switches ? switches.state !== true : null,
    ring: lights ? ringOf(lights) : null,
  };
}

async function changeMicrophones(
  { client }: Session,
  mute: Entity,
  microphones: boolean,
) {
  const id = entityId("switch", mute.objectId);
  const muted = !microphones;
  const matches = (event: TelemetryEvent & { type: "switch" }) =>
    (event.state === true) === muted;
  const current = client.latest(id);
  if (current && matches(current)) return;
  try {
    await client.commandAndAwait(id, { state: muted }, { predicate: matches });
  } catch (error) {
    // The hardware switch can prevent unmuting while the connection stays open.
    if (
      microphones &&
      error instanceof DOMException &&
      error.name === "TimeoutError" &&
      client.latest(id)?.state === true
    ) {
      throw new ActionError("conflict", "Still muted by its side switch");
    }
    throw error;
  }
}

async function changeRing(
  { client }: Session,
  ring: Entity,
  change: Partial<Ring>,
) {
  const { glow, brightness, colour } = change;
  if (glow === undefined && brightness === undefined && colour === undefined) {
    return;
  }

  const id = entityId("light", ring.objectId);
  const matches = (event: TelemetryEvent & { type: "light" }) => {
    const actual = ringOf(event);
    return (
      (glow === undefined || actual.glow === glow) &&
      (brightness === undefined || actual.brightness === brightness) &&
      (colour === undefined || ringColourDistance(actual.colour, colour) <= 2)
    );
  };
  const current = client.latest(id);
  if (current && matches(current)) return;

  // ESPHome keeps the fields a command leaves out, including whether it glows.
  await client.commandAndAwait(
    id,
    {
      ...(glow !== undefined && { state: glow }),
      ...(brightness !== undefined && { brightness: brightness / 100 }),
      ...(colour !== undefined && { rgb: ringRgb(colour), colorBrightness: 1 }),
    },
    { predicate: matches },
  );
}

export async function changeSpeaker(
  session: Session,
  parts: SpeakerParts,
  change: SpeakerChange,
) {
  if (change.microphones !== undefined && !parts.mute) {
    throw new ActionError("not_found", "It has no microphones' switch");
  }
  if (change.ring && !parts.ring) {
    throw new ActionError("not_found", "It has no ring");
  }
  if (change.microphones !== undefined && parts.mute) {
    await changeMicrophones(session, parts.mute, change.microphones);
  }
  if (change.ring && parts.ring)
    await changeRing(session, parts.ring, change.ring);
}

import { ActionError, type AudioState } from "@meetsanctum/app-sdk";
import {
  EntityCategory,
  entityId,
  type Entity,
  type TelemetryEvent,
} from "esphome-client";

import type { Session } from "./connection.js";
import { ringColourDistance, ringRgb } from "./ring-colour.js";
import { hasVoiceAssistant } from "./registration.js";

// A smart speaker's own parts: the Mute switch its firmware has, which is
// its microphones in the core (its `audio` part), and its ring, the LED
// Ring light, which only ESPHome's page shows. The ring is never a light in
// the home: its colour and brightness are those of every animation the
// speaker shows as it listens and answers, the speaker's look rather than
// a lamp. The Home Assistant Voice PE's firmware names both so, as
// settings of its own, and its side switch mutes it too.

/** A smart speaker's own parts, by their entities, where it has them. */
export type SpeakerParts = { mute: Entity | null; ring: Entity | null };

/** What a smart speaker's page shows of it. */
export type SpeakerState = {
  /** Its ring, unknown until it says. */
  ring: Ring | null;
};

export type Ring = {
  /** Whether it glows while it waits, besides while it's busy. */
  glow: boolean;
  /** Its colour, as #rrggbb. */
  colour: string;
  /** Its brightness, in percent. */
  brightness: number;
};

/** A change to a smart speaker's ring, each part left as it is where unsaid. */
export type SpeakerChange = { ring: Partial<Ring> };

/** A smart speaker's own parts, or null for a device that isn't one. */
export function speakerPartsOf(session: {
  info: Pick<Session["info"], "voiceAssistantFeatureFlags">;
  entities: readonly Entity[];
}): SpeakerParts | null {
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

export function speakerStateOf(
  { client }: Session,
  { ring }: SpeakerParts,
): SpeakerState {
  const lights = ring && client.latest(entityId("light", ring.objectId));
  return { ring: lights ? ringOf(lights) : null };
}

/** Whether its Mute switch is on, which its side switch turns on too. */
export function mutedOf({ client }: Session, { mute }: SpeakerParts) {
  const switches = mute && client.latest(entityId("switch", mute.objectId));
  return switches ? switches.state === true : null;
}

/**
 * Its microphones as the core has them: whether they're muted, where it
 * has said, and when it last heard its wake word.
 */
export function audioStateOf(
  muted: boolean | null,
  heardAt: number | null,
): AudioState {
  return {
    ...(muted !== null && { muted }),
    ...(heardAt !== null && { heardAt: new Date(heardAt).toISOString() }),
  };
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
  if (!parts.ring) throw new ActionError("not_found", "It has no ring");
  await changeRing(session, parts.ring, change.ring);
}

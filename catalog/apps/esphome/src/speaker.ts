import { ActionError } from "@meetsanctum/app-sdk";
import {
  EntityCategory,
  entityId,
  type Entity,
  type TelemetryEvent,
} from "esphome-client";

import type { Session } from "./connection.js";
import type { Facts } from "./facts.js";
import { hasVoiceAssistant } from "./registration.js";

// A smart speaker's own parts, which only ESPHome's page shows: its
// microphones, the Mute switch its firmware has, and its ring, the LED Ring
// light. The ring is never a light in the home: its colour and brightness
// are those of every animation the speaker shows as it listens and
// answers, the speaker's look rather than a lamp. The Home Assistant Voice
// PE's firmware names both so, as settings of its own.

/** A smart speaker's own parts, by their entities, where it has them. */
export type SpeakerParts = { mute: Entity | null; ring: Entity | null };

/** What a smart speaker's page shows of it. */
export type SpeakerState = {
  /** Whether its microphones are on, unknown until it says. */
  microphones: boolean | null;
  /** Its ring, unknown until it says. */
  ring: Ring | null;
  /** When it last heard its wake word, in ms since the epoch. */
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
  return parts.mute || parts.ring ? parts : null;
}

/** The names of a speaker's parts, which its page shows as its own. */
export const partNames = (parts: SpeakerParts | null) =>
  [parts?.mute?.name, parts?.ring?.name].filter(
    (name): name is string => name !== undefined,
  );

const hex = (value: number) =>
  Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, "0");

function ringOf(event: TelemetryEvent & { type: "light" }): Ring {
  const brightness =
    typeof event.brightness === "number" && Number.isFinite(event.brightness)
      ? event.brightness
      : 0;
  return {
    glow: event.state === true,
    colour: `#${hex(event.red ?? 0)}${hex(event.green ?? 0)}${hex(event.blue ?? 0)}`,
    brightness: Math.round(Math.min(1, Math.max(0, brightness)) * 100),
  };
}

const rgbOf = (colour: string) => ({
  r: parseInt(colour.slice(1, 3), 16) / 255,
  g: parseInt(colour.slice(3, 5), 16) / 255,
  b: parseInt(colour.slice(5, 7), 16) / 255,
});

// How long a change may take to show in what the speaker says: a muted
// speaker whose side switch holds it so says it's still muted.
const settleMs = 2_000;

/** Every smart speaker's own parts, as their connections last told them. */
export function createSpeakers(facts: Facts) {
  const said = new Map<string, { muted?: boolean; ring?: Ring }>();
  const waiters = new Set<() => void>();

  function until(check: () => boolean, ms: number) {
    if (check()) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const waiter = () => {
        if (!check()) return;
        clearTimeout(timer);
        waiters.delete(waiter);
        resolve(true);
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        resolve(false);
      }, ms);
      waiters.add(waiter);
    });
  }

  return {
    /** Takes what a speaker's connection says of its parts. */
    observe(mac: string, parts: SpeakerParts | null, event: TelemetryEvent) {
      if (!parts) return;
      const now = said.get(mac) ?? {};
      if (event.type === "switch" && event.key === parts.mute?.key) {
        now.muted = event.state === true;
      } else if (event.type === "light" && event.key === parts.ring?.key) {
        now.ring = ringOf(event);
      } else return;
      said.set(mac, now);
      for (const waiter of [...waiters]) waiter();
    },

    /** That a speaker heard its wake word now. */
    async heard(mac: string) {
      await facts.heard(mac, Date.now());
    },

    /** What a speaker's page shows, or null for a device that isn't one. */
    async read(mac: string, parts: SpeakerParts | null) {
      if (!parts) return null;
      const now = said.get(mac);
      const muted = parts.mute ? now?.muted : undefined;
      const state: SpeakerState = {
        microphones: muted === undefined ? null : !muted,
        ring: parts.ring ? (now?.ring ?? null) : null,
        heardWakeWordAt: (await facts.read(mac))?.heardWakeWordAt ?? null,
      };
      return state;
    },

    /**
     * Changes a speaker's parts. Microphones turned on that stay muted, as
     * its side switch holds them, are refused as a conflict.
     */
    async change(
      mac: string,
      session: Session,
      parts: SpeakerParts,
      change: SpeakerChange,
    ) {
      const { client } = session;
      if (change.ring) {
        if (!parts.ring) throw new ActionError("not_found", "It has no ring");
        const ring = { ...said.get(mac)?.ring, ...change.ring };
        const options: Record<string, unknown> = {};
        if (change.ring.glow !== undefined) options.state = change.ring.glow;
        if (change.ring.brightness !== undefined) {
          options.brightness = change.ring.brightness / 100;
        }
        if (change.ring.colour !== undefined) {
          options.rgb = rgbOf(change.ring.colour);
          options.colorBrightness = 1;
        }
        // An unlit ring keeps its colour and brightness for when it's busy.
        options.state ??= ring.glow ?? false;
        client.command(
          entityId("light", parts.ring.objectId),
          options as never,
        );
      }
      if (change.microphones !== undefined) {
        if (!parts.mute) {
          throw new ActionError("not_found", "It has no microphones' switch");
        }
        const muted = !change.microphones;
        client.command(entityId("switch", parts.mute.objectId), {
          state: muted,
        });
        const took = await until(
          () => said.get(mac)?.muted === muted,
          settleMs,
        );
        if (!took && change.microphones) {
          throw new ActionError("conflict", "Still muted by its side switch");
        }
        if (!took) throw new Error("It didn't say it was muted");
      }
    },

    forget(mac: string) {
      said.delete(mac);
    },
  };
}

export type Speakers = ReturnType<typeof createSpeakers>;

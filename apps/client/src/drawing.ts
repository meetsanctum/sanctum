import type {
  ClientInfo,
  DrawingSwitches,
  Me,
} from "@meetsanctum/auth-protocol";
import { useEffect } from "react";

import { chooseDrawing } from "./effects";
import { getShell } from "./shell";

// Reduce effects and Reduce motion for this client, as set on any client
// (Settings → Clients): the core keeps them, and they arrive in Me, and this
// device keeps a copy, so its first frame and the screens before it is
// paired draw as set too.

const preferenceKey = "drawing";

/** Reads the switches, or the explicit On choices from an older core. */
export function drawingSwitches(client: ClientInfo): DrawingSwitches {
  return (
    client.drawing ?? {
      reduceEffects: client.reduceEffects === "on",
      reduceMotion: client.reduceMotion === "on",
    }
  );
}

/** The copy this device keeps, applied as soon as it is read. */
export async function followStoredDrawing() {
  try {
    const stored = await getShell().preferences.get(preferenceKey);
    const choices: unknown = stored && JSON.parse(stored);
    if (
      typeof choices === "object" &&
      choices !== null &&
      "reduceEffects" in choices &&
      "reduceMotion" in choices &&
      typeof choices.reduceEffects === "boolean" &&
      typeof choices.reduceMotion === "boolean"
    ) {
      chooseDrawing({
        reduceEffects: choices.reduceEffects,
        reduceMotion: choices.reduceMotion,
      });
    }
  } catch {
    // A copy it can't read is left to Me.
  }
}

/** Draws as Me says, and keeps a copy. */
export function useDrawing(me: Me | undefined) {
  const { reduceEffects, reduceMotion } = me ? drawingSwitches(me.client) : {};

  useEffect(() => {
    if (reduceEffects === undefined || reduceMotion === undefined) return;
    const choices = { reduceEffects, reduceMotion };
    chooseDrawing(choices);
    void getShell()
      .preferences.set(preferenceKey, JSON.stringify(choices))
      .catch(() => undefined);
  }, [reduceEffects, reduceMotion]);
}

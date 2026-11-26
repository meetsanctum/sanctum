import type { Me } from "@meetsanctum/auth-protocol";
import { useEffect } from "react";

import { chooseDrawing, isDrawingChoices } from "./effects";
import { getShell } from "./shell";

// Reduce effects and Reduce motion for this client, as set on any client
// (Settings → Clients): the core keeps them, and they arrive in Me, and this
// device keeps a copy, so its first frame and the screens before it is
// paired draw as set too.

const preferenceKey = "drawing";
let drawingFromMe = false;

/** The copy this device keeps, applied as soon as it is read. */
export async function followStoredDrawing() {
  try {
    const stored = await getShell().preferences.get(preferenceKey);
    if (drawingFromMe) return;
    const choices: unknown = stored && JSON.parse(stored);
    if (isDrawingChoices(choices)) chooseDrawing(choices);
  } catch {
    // A copy it can't read is left to Me.
  }
}

/** Draws as Me says, and keeps a copy. */
export function useDrawing(me: Me | undefined) {
  const reduceEffects = me?.client.reduceEffects;
  const reduceMotion = me?.client.reduceMotion;

  useEffect(() => {
    // A core from before the two were switches says something else.
    const choices = { reduceEffects, reduceMotion };
    if (!isDrawingChoices(choices)) return;
    drawingFromMe = true;
    chooseDrawing(choices);
    void getShell()
      .preferences.set(preferenceKey, JSON.stringify(choices))
      .catch(() => undefined);
  }, [reduceEffects, reduceMotion]);
}

import {
  drawingChoices,
  type DrawingChoice,
  type Me,
} from "@meetsanctum/auth-protocol";
import { useEffect } from "react";

import { coreJson } from "./core-fetch";
import {
  chooseDrawing,
  followDrawn,
  sameDrawn,
  type DrawingChoices,
} from "./effects";
import { getShell } from "./shell";

// How this client draws, as chosen for it on any client (Settings →
// Clients): the core keeps the choices, which arrive in Me, and this device
// keeps a copy, so its first frame and the screens before it is paired draw
// as chosen too. It tells the core what it draws with, Automatic resolved,
// for its row in Clients.

const preferenceKey = "drawing";

const isChoice = (value: unknown): value is DrawingChoice =>
  drawingChoices.includes(value as DrawingChoice);

/** The copy this device keeps, applied as soon as it is read. */
export async function followStoredDrawing() {
  const stored = await getShell()
    .preferences.get(preferenceKey)
    .catch(() => null);
  try {
    const choices: unknown = stored && JSON.parse(stored);
    if (
      typeof choices === "object" &&
      choices !== null &&
      "effects" in choices &&
      "motion" in choices &&
      isChoice(choices.effects) &&
      isChoice(choices.motion)
    ) {
      chooseDrawing({ effects: choices.effects, motion: choices.motion });
    }
  } catch {
    // A copy it can't read is left to Me.
  }
}

/** Draws as Me says, keeps a copy, and says what it draws with. */
export function useDrawing(me: Me | undefined) {
  const effects = me?.client.reduceEffects;
  const motion = me?.client.reduceMotion;
  useEffect(() => {
    if (!effects || !motion) return;
    const choices: DrawingChoices = { effects, motion };
    chooseDrawing(choices);
    void getShell()
      .preferences.set(preferenceKey, JSON.stringify(choices))
      .catch(() => undefined);
  }, [effects, motion]);

  const signedIn = me !== undefined;
  const said = me?.client.drawn ?? null;
  const saidKey = said && `${said.effects} ${said.motion} ${said.slowDevice}`;
  useEffect(() => {
    if (!signedIn) return;
    let told = said;
    return followDrawn((drawn) => {
      if (told && sameDrawn(told, drawn)) return;
      told = drawn;
      coreJson("/api/auth/me/drawn", { method: "POST", json: drawn }).catch(
        () => {
          // Said again with the next change, or the next Me.
          told = null;
        },
      );
    });
    // `said` through its key: a new Me that says the same starts nothing.
  }, [signedIn, saidKey]);
}

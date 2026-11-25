import {
  drawingChoices,
  type ClientInfo,
  type DrawingChoice,
  type Drawn,
  type Me,
  type ReportClientDrawing,
} from "@meetsanctum/auth-protocol";
import { useEffect, useRef } from "react";

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
  try {
    const stored = await getShell().preferences.get(preferenceKey);
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
  const clientId = me?.client.id;
  const apply = useRef<(client: ClientInfo) => void>(undefined);

  useEffect(() => {
    if (!effects || !motion) return;
    const choices: DrawingChoices = { effects, motion };
    void getShell()
      .preferences.set(preferenceKey, JSON.stringify(choices))
      .catch(() => undefined);
  }, [effects, motion]);

  useEffect(() => {
    if (!clientId) return;
    let drawn: Drawn | undefined;
    let reported: Drawn | null;
    let revision: number | undefined;
    let sending = false;
    let queued = false;
    let stopped = false;

    async function report() {
      if (stopped || !drawn || revision === undefined) return;
      if (sending) {
        queued = true;
        return;
      }
      if (reported && sameDrawn(reported, drawn)) return;
      const sent: ReportClientDrawing = { ...drawn, drawingRevision: revision };
      sending = true;
      try {
        await coreJson("/api/auth/me/drawn", { method: "POST", json: sent });
        if (revision === sent.drawingRevision) reported = sent;
      } catch {
        // The next refresh or appearance change gives it another try.
      }
      sending = false;
      if (queued) {
        queued = false;
        void report();
      }
    }

    const stop = followDrawn((next) => {
      drawn = next;
      void report();
    });
    apply.current = (client) => {
      // Applying the choices can call the listener synchronously.
      revision = undefined;
      if (client.reduceEffects && client.reduceMotion) {
        chooseDrawing({
          effects: client.reduceEffects,
          motion: client.reduceMotion,
        });
      }
      reported = client.drawn;
      revision = client.drawingRevision;
      void report();
    };
    return () => {
      stopped = true;
      stop();
      apply.current = undefined;
    };
  }, [clientId]);

  useEffect(() => {
    if (me) apply.current?.(me.client);
  }, [me]);
}

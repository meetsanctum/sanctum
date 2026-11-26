import { z } from "zod";

import { deviceKey } from "./devices.js";

// Listening: a smart speaker's request, as its driver hands it to the core.
// When the speaker hears its wake word, or its button is pressed, the
// driver opens a run with ctx.audio.listen() before it lets the speaker
// stream. The core takes the run or refuses it; a refused run is declined
// on the speaker, so nothing it hears leaves it. A taken run carries the
// microphone's sound to the core, 16 kHz, 16-bit mono PCM as the speaker
// sends it, and the core tells the driver each step to show: listening has
// stopped, what was heard, the reply to play, an error, or that the run is
// done. The sound goes to the core alone, never to an app, and the core
// keeps it only while the run lasts.
//
// A run's sound reaches the core as calls, each answered once the core has
// it, so a driver sends at most `listenAhead` chunks ahead of the core's
// answers, and ends the run when it falls `listenBehindMs` behind. The core
// ends a run on its own limits too: one run per speaker, `listenMaxMs` of
// sound at most, and `listenQuietMs` without any.

/** How the microphone's sound reaches the core: 16 kHz, 16-bit mono PCM. */
export const listenRate = 16_000;
/** The most sound one call carries, in bytes (a quarter of a second). */
export const maxListenChunkBytes = 8_000;
/** How many chunks a driver sends before the core has answered the first. */
export const listenAhead = 5;
/** How far a driver may fall behind before it ends the run, in ms of sound. */
export const listenBehindMs = 2_000;
/** The most sound a run takes, in ms; listening stops there. */
export const listenMaxMs = 8_000;
/** How long a run waits for sound before it ends, in ms. */
export const listenQuietMs = 2_000;
/** How long a read waits for a step before it answers with none. */
export const listenReadWaitMs = 5_000;

/** Why the core doesn't take a run: the speaker shows it was declined. */
export const listenRefusals = [
  // No audio handler is active.
  "off",
  // Too many runs in the home at once.
  "limited",
  // The core can't hear now, as when it is stopping.
  "unavailable",
] as const;
export type ListenRefusal = (typeof listenRefusals)[number];

/** What a run ends in, when it ends in an error: each lights the speaker's error. */
export const listenErrors = [
  // What was said isn't something it knows.
  "not-understood",
  // It stopped hearing anything it could use.
  "nothing-heard",
  // Something on Sanctum's side failed.
  "failed",
] as const;
export type ListenError = (typeof listenErrors)[number];

/** Why a driver closes a run. */
export const listenEnds = [
  // The run is done, and any reply has been played.
  "played",
  // The run is done; whether a reply played isn't known.
  "done",
  // The speaker stopped it itself, as with a press of its button.
  "stopped",
  // The connection to the speaker went.
  "disconnected",
  // The driver fell too far behind.
  "behind",
] as const;
export type ListenEnd = (typeof listenEnds)[number];

/** A step the core tells the driver to show on the speaker, in order. */
export type ListenStep =
  // Listening has stopped: the speaker stops sending its sound.
  | { step: "stopped" }
  // What was heard, in words.
  | { step: "heard"; text: string }
  // A reply to play from an address on the home's network, as for an
  // announcement, with its words.
  | { step: "reply"; url: string; text: string }
  | { step: "error"; error: ListenError }
  // The run is over: nothing more follows.
  | { step: "done" };

const runId = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);

export const listenOpenSchema = z.strictObject({
  key: deviceKey,
  // The wake word it heard, or null when its button started it.
  wakeWord: z.string().trim().min(1).max(64).nullable(),
});
export type ListenOpen = z.infer<typeof listenOpenSchema>;

export type ListenOpened =
  { accepted: true; run: string } | { accepted: false; refusal: ListenRefusal };

export const listenSendSchema = z.strictObject({
  run: runId,
  // The PCM, in base64.
  audio: z
    .base64()
    .min(1)
    .max(Math.ceil(maxListenChunkBytes / 3) * 4),
});
export type ListenSend = z.infer<typeof listenSendSchema>;

export const listenReadSchema = z.strictObject({
  run: runId,
  // How many steps the driver has had already.
  after: z.number().int().nonnegative(),
});
export type ListenRead = z.infer<typeof listenReadSchema>;

export const listenCloseSchema = z.strictObject({
  run: runId,
  end: z.enum(listenEnds),
});
export type ListenClose = z.infer<typeof listenCloseSchema>;

/** The calls a run makes, as CoreCalls has them. */
export type ListenCalls = {
  /** Opens a run for one of the driver's smart speakers; needs `devices.register`. */
  openListen(open: ListenOpen): Promise<ListenOpened>;
  /** Hands the core a run's next sound. */
  sendListen(send: ListenSend): Promise<void>;
  /** A run's steps after the first `after`, waiting a moment for one when there's none yet. */
  readListen(read: ListenRead): Promise<ListenStep[]>;
  /** Ends a run. */
  closeListen(close: ListenClose): Promise<void>;
};

/** A run the core took, as its driver holds it. */
export type VoiceRun = {
  accepted: true;
  /**
   * Hands the core the speaker's next sound, which it sends in order. Past
   * `listenBehindMs` of sound not yet taken, the run ends as `behind`.
   */
  send(pcm: Uint8Array): void;
  /** The steps to show on the speaker, in order, ending with `done`. */
  steps(): AsyncIterable<ListenStep>;
  /** Ends the run; later sound is dropped. */
  close(end: ListenEnd): Promise<void>;
};

/** A run the core refused: the driver declines it on the speaker. */
export type RefusedRun = { accepted: false; refusal: ListenRefusal };

const msOf = (bytes: number) => (bytes / 2 / listenRate) * 1000;

/** Opens a run for a driver's speaker over the core's calls (ctx.audio.listen). */
export async function openVoiceRun(
  core: ListenCalls,
  open: ListenOpen,
): Promise<VoiceRun | RefusedRun> {
  const opened = await core.openListen(open);
  if (!opened.accepted) return opened;
  const run = opened.run;
  let closed = false;
  let inFlight = 0;
  const queued: Uint8Array[] = [];
  let queuedBytes = 0;

  const close = async (end: ListenEnd) => {
    if (closed) return;
    closed = true;
    queued.length = 0;
    queuedBytes = 0;
    await core.closeListen({ run, end });
  };

  const pump = () => {
    while (!closed && inFlight < listenAhead && queued.length > 0) {
      const chunk = queued.shift()!;
      queuedBytes -= chunk.byteLength;
      inFlight += 1;
      core
        .sendListen({ run, audio: Buffer.from(chunk).toString("base64") })
        .then(
          () => {
            inFlight -= 1;
            pump();
          },
          // The core ended the run, which its steps say.
          () => {
            inFlight -= 1;
            closed = true;
          },
        );
    }
  };

  return {
    accepted: true,
    send(pcm) {
      if (closed || pcm.byteLength === 0) return;
      for (let at = 0; at < pcm.byteLength; at += maxListenChunkBytes) {
        const chunk = pcm.subarray(at, at + maxListenChunkBytes);
        queued.push(chunk);
        queuedBytes += chunk.byteLength;
      }
      if (msOf(queuedBytes) > listenBehindMs) {
        void close("behind").catch(() => undefined);
        return;
      }
      pump();
    },
    async *steps() {
      let after = 0;
      for (;;) {
        const steps = await core.readListen({ run, after });
        for (const step of steps) {
          after += 1;
          yield step;
          if (step.step === "done") return;
        }
      }
    },
    close,
  };
}

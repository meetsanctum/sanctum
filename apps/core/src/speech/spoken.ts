import {
  assistantAppId,
  requestTextMaxLength,
  type AssistantRequest,
  type AssistantRequestInput,
  type ListenRefusal,
  type RequestLanguage,
  type RequestReply,
} from "@meetsanctum/app-sdk";

import type { ActivityAuthor, NewActivityEntry } from "../activity/activity.js";
import type { TurnOpener } from "../agents/assistants.js";
import { minuteWindows } from "../agents/limits.js";
import { ActionCallError } from "../app-host/errors.js";
import {
  listeningRunMs,
  type Hearer,
  type HeardRun,
  type RunMoments,
} from "./listening.js";

// A smart speaker someone asks: its run (listening.ts) becomes a request to
// Sanctum's Assistant, opened by the core for the speaker, never by an app.
// The speaker's words are heard from its sound, the Assistant gets them as
// a typed request's, and its reply is said on the speaker as the run's
// reply. The Assistant acts for the speaker only while its request lasts,
// and only while the driver that opened the run still drives it.
//
// A reply that only confirms an action that worked plays the speaker's
// success chime in place of its words, or says them where the chime can't.
// A reply not ready 5 s after listening stops gets "One moment", which ends
// the run, and follows on the speaker through the announcement queue when
// it comes, whether or not AI agents may speak there, since it finishes
// what someone asked. A newer request from the speaker drops it. Each
// request writes one Activity line with its moments, never what was said,
// and a run refused writes why.

/** How long after listening stops a reply may take before "One moment". */
export const oneMomentAfterMs = 5_000;

/** What a speaker says on its own, in each language: kept ready once said. */
export const spokenPhrases = {
  oneMoment: { en: "One moment", de: "Einen Moment" },
  failed: {
    en: "Sorry, that didn't work",
    de: "Das hat leider nicht geklappt",
  },
} as const satisfies Record<string, Record<RequestLanguage, string>>;

/**
 * Hears a run's words from its sound, in the home's language, and stops
 * listening once speech ends: null when nothing was said, "" for speech it
 * doesn't know.
 */
export type Transcriber = (run: {
  sound: AsyncIterable<Buffer>;
  stopListening(): void;
  language: RequestLanguage;
  signal: AbortSignal;
}) => Promise<string | null>;

/** A smart speaker as a request names it. */
export type Speaker = {
  name: string;
  capability: string;
  room: AssistantRequest["room"];
};

// Why a run was refused, as Activity says it.
type Declined = "assistant_off" | "no_speech_to_text" | ListenRefusal;

type Asking = { run: HeardRun; cancel: AbortController };
type Answer =
  | { empty: "nothing-heard" | "not-understood" }
  | { reply: RequestReply | null };

function delay(ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<void>((done) => {
    timer = setTimeout(done, ms);
    timer.unref();
  });
  return { waited, clear: () => clearTimeout(timer) };
}

function ended(signal: AbortSignal) {
  return new Promise<void>((done) => {
    if (signal.aborted) done();
    else signal.addEventListener("abort", () => done(), { once: true });
  });
}

// Each moment after the wake word, in ms, or null while it hasn't come.
function sinceHeard(moments: Readonly<RunMoments>) {
  const after = (at: number | null) =>
    at === null ? null : Math.max(0, at - moments.heard);
  return {
    firstSoundMs: after(moments.firstSound),
    stoppedListeningMs: after(moments.stoppedListening),
    replyReadyMs: after(moments.replyReady),
    finishedPlayingMs: after(moments.finishedPlaying),
  };
}

export function createSpokenRequests(options: {
  // What hears words in a run's sound, while it runs.
  transcriber: () => Transcriber | null;
  // The home's one language for speech.
  language: () => RequestLanguage;
  speaker: (device: string) => Speaker | null;
  // Whether `driver` still drives the device and runs.
  drives: (driver: string, device: string) => boolean;
  requests: {
    answers(): boolean;
    hasRoom(key: string): boolean;
    ask(request: {
      actor: TurnOpener;
      key: string;
      who: ActivityAuthor;
      asked: AssistantRequestInput;
      check?: () => void;
      signal?: AbortSignal;
    }): Promise<RequestReply | null>;
    forget(key: string): void;
  };
  speech: () =>
    | {
        keepRepliesReady?(): () => void;
        reply(input: {
          device: string;
          text: string;
          language: RequestLanguage;
          confirmation?: boolean;
          signal?: AbortSignal;
          onPlayback?: (finished: boolean) => void;
        }): Promise<string>;
        speak(input: {
          device: string;
          text: string;
          language: RequestLanguage;
          actor: { kind: "app"; id: string };
          finishing: true;
          confirmation?: boolean;
          beforeTelling: () => void;
          signal: AbortSignal;
        }): Promise<unknown>;
      }
    | undefined;
  record: (entry: NewActivityEntry) => void;
  now?: () => number;
  log: (message: string) => void;
}) {
  const now = options.now ?? Date.now;
  // Each speaker's request, from its run's acceptance until its reply is
  // told or dropped.
  const asking = new Map<string, Asking>();
  const logRefusal = minuteWindows(
    { agentPerMinute: 1, homePerMinute: 4 },
    now,
  );

  function isCurrent({ run, cancel }: Asking) {
    return (
      !cancel.signal.aborted &&
      asking.get(run.device)?.run === run &&
      options.drives(run.driver, run.device)
    );
  }

  function actsFor(device: string) {
    const request = asking.get(device);
    return request !== undefined && isCurrent(request);
  }

  function declined(device: string, why: Declined, driver: string) {
    const capability = options.speaker(device)?.capability;
    if (!capability || logRefusal(driver) !== undefined) return;
    options.record({
      action: "device.declined",
      outcome: "refused",
      reason: why,
      subjectId: device,
      actor: "sanctum",
      detail: { capability, capabilityKind: "audio" },
    });
  }

  function recorded(
    request: Asking,
    speaker: Speaker,
    outcome: { ok: true; late?: number } | { ok: false; reason: string },
    handedOff = false,
  ) {
    const { run } = request;
    const moments = sinceHeard(run.moments);
    options.record({
      action: "device.request",
      outcome: outcome.ok ? "ok" : "failed",
      ...(outcome.ok ? {} : { reason: outcome.reason }),
      subjectId: run.device,
      actor: `speaker:${run.device}`,
      clientName: speaker.name,
      detail: {
        capability: speaker.capability,
        capabilityKind: "audio",
        ...moments,
        ...(handedOff ? { replyReadyMs: null, finishedPlayingMs: null } : {}),
        ...(outcome.ok && outcome.late !== undefined
          ? { lateReplyMs: outcome.late }
          : {}),
      },
    });
  }

  // Says a reply after "One moment", unless a newer request took over.
  async function sayLate(
    request: Asking,
    reply: RequestReply,
    language: RequestLanguage,
  ) {
    if (!isCurrent(request)) return false;
    const speech = options.speech();
    if (!speech) return false;
    try {
      await speech.speak({
        device: request.run.device,
        text: reply.text,
        language,
        actor: { kind: "app", id: assistantAppId },
        finishing: true,
        signal: request.cancel.signal,
        beforeTelling: () => {
          if (!isCurrent(request)) throw new ActionCallError("turn_ended");
        },
        ...(reply.confirmation ? { confirmation: true } : {}),
      });
      return true;
    } catch (error) {
      if (isCurrent(request)) {
        options.log(
          `speech: a smart speaker's late reply wasn't said (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      return false;
    }
  }

  // Prepares audio without handing it to the driver. A reply that misses
  // its deadline can be withdrawn while it synthesizes or waits its turn.
  async function prepareReply(
    run: HeardRun,
    reply: RequestReply,
    language: RequestLanguage,
    signal: AbortSignal,
    placeholder = false,
  ) {
    const speech = options.speech();
    if (!speech) return null;
    try {
      return await speech.reply({
        device: run.device,
        text: reply.text,
        language,
        ...(reply.confirmation ? { confirmation: true } : {}),
        signal,
        onPlayback(finished) {
          if (finished || placeholder) run.done();
          else run.fail("failed");
        },
      });
    } catch (error) {
      if (!signal.aborted) {
        options.log(
          `speech: a smart speaker's reply wasn't said (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      return null;
    }
  }

  async function hear(run: HeardRun, transcriber: Transcriber) {
    const key = run.device;
    const speaker = options.speaker(key);
    if (!speaker) {
      run.fail("failed");
      return;
    }
    asking.get(key)?.cancel.abort();
    const request: Asking = { run, cancel: new AbortController() };
    asking.set(key, request);
    const releaseSpeech = options.speech()?.keepRepliesReady?.();
    const language = options.language();
    const { signal } = request.cancel;
    const runEnded = ended(run.signal);
    const interrupted = ended(signal).then(() => "ended" as const);
    const preparing = new AbortController();
    let handingOff = false;
    let asked = false;
    const finishedNormally = () =>
      run.ended === "played" || run.ended === "done";
    const onRunEnd = () => {
      if (!handingOff || !finishedNormally()) request.cancel.abort();
    };
    run.signal.addEventListener("abort", onRunEnd, { once: true });
    let wait: ReturnType<typeof delay> | undefined;
    const transcriptionLimit = delay(listeningRunMs);
    try {
      const deadline = run.stopped.then(() => {
        if (run.signal.aborted) return "ended" as const;
        const stopped = run.moments.stoppedListening ?? now();
        wait = delay(Math.max(0, stopped + oneMomentAfterMs - now()));
        return wait.waited.then(() => "late" as const);
      });
      const answer = async (): Promise<Answer> => {
        // The acknowledgement can close the listening run before these
        // words are ready. Transcription still has the original run limit.
        const transcription = new AbortController();
        const text = await Promise.race([
          transcriber({
            sound: run.sound,
            stopListening: () => run.stopListening(),
            language,
            signal: AbortSignal.any([signal, transcription.signal]),
          }),
          transcriptionLimit.waited.then(() => {
            const error = new ActionCallError("timeout");
            transcription.abort(error);
            throw error;
          }),
        ]).finally(transcriptionLimit.clear);
        signal.throwIfAborted();
        run.stopListening();
        const words = text?.trim().slice(0, requestTextMaxLength).trim();
        if (!words)
          return {
            empty: text === null ? "nothing-heard" : "not-understood",
          } as const;
        if (!handingOff) run.heard(words);
        asked = true;
        const reply = await options.requests.ask({
          actor: { kind: "device", id: key },
          key,
          who: { actor: `speaker:${key}`, clientName: speaker.name },
          asked: {
            text: words,
            language,
            room: speaker.room,
            from: { kind: "speaker", name: speaker.name },
          },
          check: () => {
            if (!isCurrent(request)) throw new ActionCallError("unavailable");
          },
          signal,
        });
        return { reply };
      };
      const answered = answer().catch((error: unknown) => ({ error }));
      const prepared = answered.then(async (result) => {
        if (!("reply" in result) || !result.reply || preparing.signal.aborted)
          return result;
        const url = await prepareReply(
          run,
          result.reply,
          language,
          AbortSignal.any([run.signal, preparing.signal]),
        );
        return { ...result, url };
      });
      const first = await Promise.race([prepared, deadline, interrupted]);
      wait?.clear();
      if (first === "ended" || signal.aborted) {
        if (asked)
          recorded(request, speaker, { ok: false, reason: "turn_ended" });
        return;
      }

      if (first !== "late") {
        if ("empty" in first) {
          run.fail(first.empty);
          return;
        }
        if ("error" in first) {
          recorded(request, speaker, { ok: false, reason: reasonOf(first) });
          run.fail("failed");
          return;
        }
        if (first.reply) {
          if (!("url" in first) || !first.url) {
            recorded(request, speaker, { ok: false, reason: "unavailable" });
            run.fail("failed");
            return;
          }
          run.reply(first.url, first.reply.text);
        } else {
          run.done();
        }
        await runEnded;
        recorded(
          request,
          speaker,
          finishedNormally()
            ? { ok: true }
            : {
                ok: false,
                reason:
                  asking.get(key) === request && run.ended === null
                    ? "unavailable"
                    : "turn_ended",
              },
        );
        return;
      }

      // Too slow: "One moment" ends the run, and the reply follows.
      handingOff = true;
      preparing.abort();
      const oneMoment = { text: spokenPhrases.oneMoment[language] };
      const placeholder = await prepareReply(
        run,
        oneMoment,
        language,
        run.signal,
        true,
      );
      if (placeholder) run.reply(placeholder, oneMoment.text);
      else run.done();
      const later = await Promise.race([answered, interrupted]);
      await runEnded;
      if (later === "ended" || signal.aborted) {
        if (asked)
          recorded(request, speaker, { ok: false, reason: "turn_ended" }, true);
      } else if ("error" in later) {
        await sayLate(
          request,
          { text: spokenPhrases.failed[language] },
          language,
        );
        recorded(
          request,
          speaker,
          { ok: false, reason: reasonOf(later) },
          true,
        );
      } else if ("reply" in later && later.reply) {
        const said = await sayLate(request, later.reply, language);
        recorded(
          request,
          speaker,
          said
            ? { ok: true, late: now() - run.moments.heard }
            : {
                ok: false,
                reason: signal.aborted ? "turn_ended" : "unavailable",
              },
          true,
        );
      } else if ("reply" in later) {
        recorded(request, speaker, { ok: true }, true);
      }
    } finally {
      wait?.clear();
      transcriptionLimit.clear();
      run.signal.removeEventListener("abort", onRunEnd);
      if (asking.get(key) === request) asking.delete(key);
      releaseSpeech?.();
    }
  }

  return {
    /**
     * What hears a smart speaker's run: refused while the Assistant is off,
     * nothing hears words, or the speaker asked too often in the last
     * minute. Refusals are logged within a separate Activity limit.
     */
    hearer(device: string, driver: string): Hearer | ListenRefusal {
      if (!options.requests.answers()) {
        declined(device, "assistant_off", driver);
        return "off";
      }
      const transcriber = options.transcriber();
      if (!transcriber) {
        declined(device, "no_speech_to_text", driver);
        return "off";
      }
      if (!options.requests.hasRoom(device)) {
        declined(device, "limited", driver);
        return "limited";
      }
      return (run) => hear(run, transcriber);
    },

    /** A run the core refused on its own account. */
    refused(device: string, refusal: ListenRefusal, driver: string) {
      declined(device, refusal, driver);
    },

    /** Whether the Assistant may act for the speaker: its request lasts. */
    actsFor,

    /** A smart speaker went: its request ends, and its window goes. */
    deviceGone(device: string) {
      options.requests.forget(device);
      asking.get(device)?.cancel.abort();
    },

    driverStopped(driver: string) {
      for (const request of asking.values()) {
        if (request.run.driver === driver) request.cancel.abort();
      }
    },

    stop() {
      for (const request of asking.values()) request.cancel.abort();
    },
  };
}

function reasonOf(failed: { error: unknown }) {
  return failed.error instanceof ActionCallError ? failed.error.code : "failed";
}

export type SpokenRequests = ReturnType<typeof createSpokenRequests>;

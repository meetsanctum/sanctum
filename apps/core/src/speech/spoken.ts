import {
  assistantAppId,
  requestTextMaxLength,
  type AssistantRequest,
  type ListenRefusal,
  type RequestLanguage,
  type RequestReply,
} from "@meetsanctum/app-sdk";

import type { ActivityAuthor, NewActivityEntry } from "../activity/activity.js";
import type { TurnOpener } from "../agents/assistants.js";
import { ActionCallError } from "../app-host/errors.js";
import type { Hearer, HeardRun, RunMoments } from "./listening.js";

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
  room: AssistantRequest["room"];
};

// Why a run was refused, as Activity says it.
type Declined = "assistant_off" | "no_speech_to_text" | ListenRefusal;

type Asking = { run: HeardRun };

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
      asked: Omit<AssistantRequest, "earlier">;
      check?: () => void;
    }): Promise<RequestReply | null>;
    forget(key: string): void;
  };
  speech: () =>
    | {
        reply(input: {
          device: string;
          text: string;
          language: RequestLanguage;
          confirmation?: boolean;
          signal?: AbortSignal;
        }): Promise<string>;
        speak(input: {
          device: string;
          text: string;
          language: RequestLanguage;
          actor: { kind: "app"; id: string };
          finishing: true;
          confirmation?: boolean;
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

  function actsFor(device: string) {
    const request = asking.get(device);
    return request !== undefined && options.drives(request.run.driver, device);
  }

  function declined(device: string, why: Declined) {
    options.record({
      action: "device.declined",
      outcome: "refused",
      reason: why,
      subjectId: device,
      actor: "sanctum",
    });
  }

  function recorded(
    request: Asking,
    speaker: Speaker,
    outcome: { ok: true; late?: number } | { ok: false; reason: string },
  ) {
    const { run } = request;
    options.record({
      action: "device.request",
      outcome: outcome.ok ? "ok" : "failed",
      ...(outcome.ok ? {} : { reason: outcome.reason }),
      subjectId: run.device,
      actor: `speaker:${run.device}`,
      clientName: speaker.name,
      detail: {
        ...sinceHeard(run.moments),
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
    if (asking.get(request.run.device) !== request) return false;
    const speech = options.speech();
    if (!speech) return false;
    try {
      await speech.speak({
        device: request.run.device,
        text: reply.text,
        language,
        actor: { kind: "app", id: assistantAppId },
        finishing: true,
        ...(reply.confirmation ? { confirmation: true } : {}),
      });
      return true;
    } catch (error) {
      options.log(
        `speech: a smart speaker's late reply wasn't said (${error instanceof Error ? error.message : String(error)})`,
      );
      return false;
    }
  }

  // The run's reply, said on its speaker, or false when it couldn't be: a
  // confirmation as the success chime where it can.
  async function sayInRun(
    run: HeardRun,
    reply: RequestReply,
    language: RequestLanguage,
  ) {
    const speech = options.speech();
    if (!speech) return false;
    try {
      const url = await speech.reply({
        device: run.device,
        text: reply.text,
        language,
        ...(reply.confirmation ? { confirmation: true } : {}),
        signal: run.signal,
      });
      run.reply(url, reply.text);
      return true;
    } catch (error) {
      if (!run.signal.aborted) {
        options.log(
          `speech: a smart speaker's reply wasn't said (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      return false;
    }
  }

  async function hear(run: HeardRun, transcriber: Transcriber) {
    const key = run.device;
    const speaker = options.speaker(key);
    if (!speaker) {
      run.fail("failed");
      return;
    }
    const request: Asking = { run };
    asking.set(key, request);
    const language = options.language();
    const leave = () => {
      if (asking.get(key) === request) asking.delete(key);
    };
    try {
      const text = await transcriber({
        sound: run.sound,
        stopListening: () => run.stopListening(),
        language,
        signal: run.signal,
      });
      run.stopListening();
      if (run.signal.aborted) return;
      const words = text?.trim().slice(0, requestTextMaxLength).trim();
      if (!words) {
        run.fail(text === null ? "nothing-heard" : "not-understood");
        return;
      }
      run.heard(words);
      const answered = options.requests
        .ask({
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
            if (!actsFor(key)) throw new ActionCallError("unavailable");
          },
        })
        .then(
          (reply) => ({ reply }),
          (error: unknown) => ({ error }),
        );
      // Five seconds from when listening stopped, hearing the words included.
      const stopped = run.moments.stoppedListening ?? now();
      const wait = delay(Math.max(0, stopped + oneMomentAfterMs - now()));
      const first = await Promise.race([
        answered,
        wait.waited.then(() => "late" as const),
        ended(run.signal).then(() => "ended" as const),
      ]);
      wait.clear();
      // A newer run on the speaker, its removal or its driver stopping
      // ended it: nothing is left to tell it.
      if (first === "ended") {
        recorded(request, speaker, { ok: false, reason: "turn_ended" });
        return;
      }

      if (first !== "late") {
        if ("error" in first) {
          run.fail("failed");
          recorded(request, speaker, { ok: false, reason: reasonOf(first) });
          return;
        }
        const said =
          first.reply !== null && (await sayInRun(run, first.reply, language));
        if (first.reply !== null && !said) {
          if (!run.signal.aborted) run.fail("failed");
          recorded(request, speaker, { ok: false, reason: "unavailable" });
          return;
        }
        if (!said) run.done();
        await ended(run.signal);
        recorded(request, speaker, { ok: true });
        return;
      }

      // Too slow: "One moment" ends the run, and the reply follows.
      const oneMoment = { text: spokenPhrases.oneMoment[language] };
      if (!(await sayInRun(run, oneMoment, language))) {
        run.done();
      }
      const later = await answered;
      const late = now() - run.moments.heard;
      const lateReply =
        "error" in later
          ? { text: spokenPhrases.failed[language] }
          : later.reply;
      if (lateReply) await sayLate(request, lateReply, language);
      if (!run.signal.aborted) await ended(run.signal);
      recorded(
        request,
        speaker,
        "error" in later
          ? { ok: false, reason: reasonOf(later) }
          : { ok: true, late },
      );
    } finally {
      leave();
    }
  }

  return {
    /**
     * What hears a smart speaker's run: refused while the Assistant is off,
     * nothing hears words, or the speaker asked too often in the last
     * minute, each with a line in Activity.
     */
    hearer(device: string): Hearer | ListenRefusal {
      if (!options.requests.answers()) {
        declined(device, "assistant_off");
        return "off";
      }
      const transcriber = options.transcriber();
      if (!transcriber) {
        declined(device, "no_speech_to_text");
        return "off";
      }
      if (!options.requests.hasRoom(device)) {
        declined(device, "limited");
        return "limited";
      }
      return (run) => hear(run, transcriber);
    },

    /** A run the core refused on its own account. */
    refused(device: string, refusal: ListenRefusal) {
      declined(device, refusal);
    },

    /** Whether the Assistant may act for the speaker: its request lasts. */
    actsFor,

    /** A smart speaker went: its request ends, and its window goes. */
    deviceGone(device: string) {
      asking.delete(device);
      options.requests.forget(device);
    },
  };
}

function reasonOf(failed: { error: unknown }) {
  return failed.error instanceof ActionCallError ? failed.error.code : "failed";
}

export type SpokenRequests = ReturnType<typeof createSpokenRequests>;

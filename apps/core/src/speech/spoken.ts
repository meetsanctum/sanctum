import {
  assistantAppId,
  requestTextMaxLength,
  type AssistantRequest,
  type AssistantRequestInput,
  type ListenRefusal,
  type SpeechLanguage,
  type RequestReply,
} from "@meetsanctum/app-sdk";

import type { ActivityAuthor, NewActivityEntry } from "../activity/activity.js";
import type { TurnOpener } from "../agents/assistants.js";
import { minuteWindows } from "../agents/limits.js";
import { ActionCallError } from "../app-host/errors.js";
import type { Hearer, HeardRun, RunMoments } from "./listening.js";
import type { Speech } from "./speech.js";
import type { SpeechTranscript } from "./words.js";

// A smart speaker someone asks: its run (listening.ts) becomes a request to
// Sanctum's Assistant, opened by the core for the speaker, never by an app.
// The speaker's words are heard from its sound, the Assistant gets them as
// a typed request's, and its reply is said on the speaker as the run's
// reply. The Assistant acts for the speaker only while its request lasts,
// and only while the driver that opened the run still drives it.
//
// A reply that only confirms an action that worked plays the speaker's
// success chime in place of its words, or says them where the chime can't.
// A request that fails without words to say ends in the error the speaker
// shows, then plays its error chime.
// Once words are heard, a reply not ready 5 s after listening stops gets
// "One moment". The reply follows through the speaker's announcement queue,
// whether or not AI agents may speak there, since it finishes what someone
// asked. A newer request from the speaker drops it. Each
// request writes one Activity line with its moments, never what was said,
// and a run refused writes why.

/** How long after listening stops a reply may take before "One moment". */
export const oneMomentAfterMs = 5_000;
/** How long before "One moment" a reply starts on whatever sound it has. */
const startsByMs = 250;

/** What a speaker says on its own, in each language: kept ready once said. */
export const spokenPhrases = {
  oneMoment: { en: "One moment", de: "Einen Moment" },
  failed: {
    en: "Sorry, that didn't work",
    de: "Das hat leider nicht geklappt",
  },
} as const satisfies Record<string, Record<SpeechLanguage, string>>;

/**
 * Hears a run's words and stops listening once speech ends: null when nothing
 * was said, empty text for speech it doesn't know. A plain string uses the
 * language supplied when the run started.
 */
export type Transcriber = (run: {
  sound: AsyncIterable<Buffer>;
  stopListening(): void;
  language: SpeechLanguage;
  signal: AbortSignal;
}) => Promise<SpeechTranscript | string | null>;

/** A smart speaker as a request names it. */
export type Speaker = {
  name: string;
  capability: string;
  room: AssistantRequest["room"];
};

// Why a run was refused, as Activity says it.
type Declined =
  "assistant_off" | "no_sentences" | "no_speech_to_text" | ListenRefusal;

type Asking = { run: HeardRun; cancel: AbortController };

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
  // Why nothing hears words now: the Assistant has no sentences in the
  // home's language, or speech recognition isn't ready.
  notHearing?: () => "no_sentences" | "no_speech_to_text";
  // The language speech recognition hears in: the home's one language.
  language: () => SpeechLanguage;
  // What the speaker says for speech outside the Assistant's sentences, or
  // null for nothing.
  notUnderstood?: (language: SpeechLanguage) => string | null;
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
      onTurnStarted?: (finished: Promise<void>) => void;
    }): Promise<RequestReply | null>;
    forget(key: string): void;
  };
  speech: () =>
    | {
        keepRepliesReady?(): () => void;
        reply: Speech["reply"];
        speak(input: {
          device: string;
          text: string;
          language: SpeechLanguage;
          actor: { kind: "app"; id: string };
          finishing: true;
          confirmation?: boolean;
          beforeTelling: () => void;
          signal: AbortSignal;
        }): Promise<unknown>;
        playError(input: {
          device: string;
          actor: { kind: "app"; id: string };
          beforeTelling: () => void;
          signal: AbortSignal;
        }): Promise<void>;
      }
    | undefined;
  record: (entry: NewActivityEntry) => void;
  now?: () => number;
  log: (message: string) => void;
}) {
  const now = options.now ?? Date.now;
  // Each speaker's request stays current through the handler's turn and
  // until its reply is told or dropped.
  const asking = new Map<string, Asking>();
  const errorChimes = new Map<
    string,
    { driver: string; cancel: AbortController }
  >();
  const logRefusal = minuteWindows(
    { agentPerMinute: 1, homePerMinute: 4 },
    now,
  );
  // Count microphone runs even when no words reach the Assistant.
  const takeRecognition = minuteWindows(
    { agentPerMinute: 12, homePerMinute: 60 },
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

  function declined(device: string, why: Declined) {
    const capability = options.speaker(device)?.capability;
    if (!capability || logRefusal(device) !== undefined) return;
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

  // Ends a request's run in `error`, which the speaker shows, then plays the
  // error chime there, unless a newer request has taken over by then. The
  // chime follows the run's end: a speaker stops a reply that is playing
  // when its run ends in an error.
  async function failAloud(run: HeardRun, error: "failed" | "not-understood") {
    if (run.signal.aborted) return;
    run.fail(error);
    const speech = options.speech();
    if (!speech) return;
    const { device, driver } = run;
    const cancel = new AbortController();
    const pending = { driver, cancel };
    errorChimes.set(device, pending);
    const { signal } = cancel;
    const canPlay = () =>
      !signal.aborted &&
      options.requests.answers() &&
      options.drives(driver, device);
    try {
      const end = await Promise.race([run.driverClosed, ended(signal)]);
      if (end !== "done" || !canPlay()) return;
      await speech.playError({
        device,
        actor: { kind: "app", id: assistantAppId },
        signal,
        beforeTelling: () => {
          if (!canPlay()) throw new ActionCallError("turn_ended");
        },
      });
    } catch (error) {
      if (canPlay()) {
        options.log(
          `speech: a smart speaker's error chime wasn't played (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    } finally {
      if (errorChimes.get(device) === pending) errorChimes.delete(device);
    }
  }

  function cancelDevice(device: string) {
    asking.get(device)?.cancel.abort();
    errorChimes.get(device)?.cancel.abort();
  }

  // Says a reply after "One moment", unless a newer request took over.
  async function sayLate(
    request: Asking,
    reply: RequestReply,
    language: SpeechLanguage,
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
    language: SpeechLanguage,
    signal: AbortSignal,
    placeholder = false,
    readyBy?: number,
  ) {
    const speech = options.speech();
    if (!speech) return null;
    try {
      return await speech.reply({
        device: run.device,
        text: reply.text,
        language,
        ...(reply.confirmation ? { confirmation: true } : {}),
        readyBy,
        signal,
        onPlayback(finished) {
          // Successful playback falls back to this after allowing time for
          // the driver to close the run with its measured playing time.
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
    cancelDevice(key);
    const speaker = options.speaker(key);
    if (!speaker) {
      run.fail("failed");
      return;
    }
    const request: Asking = { run, cancel: new AbortController() };
    asking.set(key, request);
    const releaseSpeech = options.speech()?.keepRepliesReady?.();
    const startingLanguage = options.language();
    const { signal } = request.cancel;
    const runEnded = ended(run.signal);
    const interrupted = ended(signal).then(() => "ended" as const);
    const preparing = new AbortController();
    let asked = false;
    let turnFinished: Promise<void> | undefined;
    const finishedNormally = () =>
      run.ended === "played" || run.ended === "done";
    const onRunEnd = () => {
      // The run bounds transcription. Once the turn starts, finishing the
      // audio leaves the turn open. A driver can still stop the request.
      if (!asked || (run.ended !== null && !finishedNormally())) {
        request.cancel.abort();
      }
    };
    run.signal.addEventListener("abort", onRunEnd, { once: true });
    let wait: ReturnType<typeof delay> | undefined;
    try {
      const transcribe = async () =>
        transcriber({
          sound: run.sound,
          stopListening: () => run.stopListening(),
          language: startingLanguage,
          signal,
        });
      const heard = await Promise.race([
        transcribe().then(
          (transcript) => ({ transcript }),
          (error: unknown) => ({ error }),
        ),
        interrupted.then(() => null),
      ]);
      if (!heard || signal.aborted) return;
      if ("error" in heard) {
        recorded(request, speaker, { ok: false, reason: reasonOf(heard) });
        void failAloud(run, "failed");
        return;
      }
      run.stopListening();
      const transcript: SpeechTranscript | null =
        typeof heard.transcript === "string"
          ? { text: heard.transcript }
          : heard.transcript;
      const text = transcript?.text ?? null;
      const language = transcript?.language ?? startingLanguage;
      const words = text?.trim().slice(0, requestTextMaxLength).trim();
      if (!words) {
        // Speech it doesn't know gets the Assistant's words; silence, none.
        const sorry =
          text === null ? null : (options.notUnderstood?.(language) ?? null);
        const url =
          sorry &&
          (await prepareReply(
            run,
            { text: sorry },
            language,
            AbortSignal.any([run.signal, signal]),
          ));
        if (sorry && url && !signal.aborted) {
          run.reply(url, sorry);
          await runEnded;
          return;
        }
        if (signal.aborted) return;
        // Silence ends quietly: the speaker may have heard its wake word in
        // a room's noise.
        if (text === null) run.fail("nothing-heard");
        else void failAloud(run, "not-understood");
        return;
      }
      run.heard(words);
      asked = true;
      const stopped = run.moments.stoppedListening ?? now();
      wait = delay(Math.max(0, stopped + oneMomentAfterMs - now()));
      const deadline = wait.waited.then(() => "late" as const);
      const answer = async () => {
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
          onTurnStarted(finished) {
            turnFinished = finished;
          },
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
          false,
          stopped + oneMomentAfterMs - startsByMs,
        );
        return { ...result, url };
      });
      const first = await Promise.race([
        prepared,
        deadline,
        interrupted,
        runEnded.then(() => "run_ended" as const),
      ]);
      wait.clear();
      if (first === "ended" || signal.aborted) {
        recorded(request, speaker, { ok: false, reason: "turn_ended" });
        return;
      }
      if (first === "run_ended") {
        recorded(request, speaker, { ok: false, reason: "unavailable" });
        return;
      }

      if (first !== "late") {
        if ("error" in first) {
          recorded(request, speaker, { ok: false, reason: reasonOf(first) });
          void failAloud(run, "failed");
          return;
        }
        if (first.reply) {
          if (!("url" in first) || !first.url) {
            recorded(request, speaker, { ok: false, reason: "unavailable" });
            void failAloud(run, "failed");
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
                reason: signal.aborted ? "turn_ended" : "unavailable",
              },
        );
        return;
      }

      // Too slow: "One moment" ends the run, and the reply follows.
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
      if (later === "ended" || signal.aborted) {
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
      } else if (later.reply) {
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
      } else {
        recorded(request, speaker, { ok: true }, true);
      }
    } finally {
      wait?.clear();
      if (turnFinished) await Promise.race([turnFinished, interrupted]);
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
    hearer(device: string): Hearer | ListenRefusal {
      if (!options.requests.answers()) {
        declined(device, "assistant_off");
        return "off";
      }
      const transcriber = options.transcriber();
      if (!transcriber) {
        declined(device, options.notHearing?.() ?? "no_speech_to_text");
        return "off";
      }
      if (
        !options.requests.hasRoom(device) ||
        takeRecognition(device) !== undefined
      ) {
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
      options.requests.forget(device);
      cancelDevice(device);
    },

    cancelDevice,

    driverStopped(driver: string) {
      for (const request of asking.values()) {
        if (request.run.driver === driver) request.cancel.abort();
      }
      for (const pending of errorChimes.values()) {
        if (pending.driver === driver) pending.cancel.abort();
      }
    },

    stop() {
      for (const request of asking.values()) request.cancel.abort();
      for (const pending of errorChimes.values()) pending.cancel.abort();
    },
  };
}

function reasonOf(failed: { error: unknown }) {
  return failed.error instanceof ActionCallError ? failed.error.code : "failed";
}

export type SpokenRequests = ReturnType<typeof createSpokenRequests>;

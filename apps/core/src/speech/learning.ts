import {
  grammarSteps,
  sentenceBlanks,
  sentenceLimits,
  type AssistantSentences,
  type RequestLanguage,
  type SentenceBlank,
} from "@meetsanctum/app-sdk";

import { ManagerRefusal } from "../manager.js";
import type { Transcriber } from "./spoken.js";
import {
  MissingSpeechLesson,
  train,
  transcribe,
  type Lesson,
} from "./words.js";

// What speech recognition knows: the core wants Speech-to-Phrase while the
// Assistant has sentences in the home's language and a smart speaker
// listens, and teaches it those sentences with the home's names filled in.
// It retrains a minute after the last change to a name, a room or floor, a
// light, a mood or the language, and until it has the new lesson it hears
// with the one it had, rather than not at all. A lesson too large to learn
// on the host isn't sent, and the one before stays.

/** The service the manager runs for it. */
export const wordsService = "speech-to-phrase";

/** How long after the last change it retrains. */
export const retrainAfterMs = 60_000;
/** How often it looks for the service while it starts. */
const lookEveryMs = 10_000;
const maxAdmissionRetryMs = 60_000;

/** Why nothing hears a speaker's run now. */
export type NotHearing = "no_sentences" | "no_speech_to_text";

type Manager = {
  serviceConnection(
    service: string,
    signal?: AbortSignal,
  ): Promise<{ url: string; token: string | null } | null>;
  wantServiceForCore(
    service: string,
    options: { signal: AbortSignal },
  ): Promise<void>;
  releaseServiceForCore(
    service: string,
    options: { signal: AbortSignal },
  ): Promise<void>;
};

type HomeLesson = Lesson & { language: RequestLanguage };

function endpointOf(url: string) {
  const parsed = URL.parse(url);
  const port = Number(parsed?.port);
  if (parsed?.protocol !== "tcp:" || !parsed.hostname || !port) return null;
  return { host: parsed.hostname, port };
}

export function createLearning(options: {
  manager: Manager;
  // The Assistant's sentences while it answers requests, or null.
  sentences: () => AssistantSentences | null;
  // The home's names for each blank.
  names: () => Record<SentenceBlank, string[]>;
  language: () => RequestLanguage;
  // Whether a smart speaker in the home listens.
  speakersListen: () => boolean;
  // For tests: how long after the last change it retrains.
  retrainAfterMs?: number;
  // The core started or stopped wanting the service.
  onWanted?: () => void;
  log: (message: string) => void;
}) {
  const retrainMs = options.retrainAfterMs ?? retrainAfterMs;
  let running = false;
  let wanted: boolean | null = null;
  let admitted = false;
  // Keep the last lesson the service acknowledged in case it loses its grammar.
  let learned: HomeLesson | null = null;
  let recovering = false;
  let changing: AbortController | null = null;
  let teaching: AbortController | null = null;
  let retrain: NodeJS.Timeout | undefined;
  let looking: NodeJS.Timeout | undefined;
  let retryAdmission: NodeJS.Timeout | undefined;

  function templates() {
    return options.sentences()?.[options.language()] ?? null;
  }

  function lesson(): HomeLesson | null {
    const language = options.language();
    const list = options.sentences()?.[language];
    if (!list) return null;
    const names = options.names();
    const used = new Set<SentenceBlank>();
    const usable = list.filter((template) => {
      const blanks = [...template.matchAll(/\{(\w+)\}/g)].map(
        ([, blank]) => blank as SentenceBlank,
      );
      if (blanks.some((blank) => !names[blank]?.length)) return false;
      for (const blank of blanks) used.add(blank);
      return true;
    });
    if (usable.length === 0) {
      options.log(
        `speech: the home has no usable ${language} sentences; keeping what it learned`,
      );
      return null;
    }
    const lists = Object.fromEntries(
      sentenceBlanks
        .filter((blank) => used.has(blank))
        .map((blank) => [blank, names[blank].slice()]),
    );
    const steps = grammarSteps(usable, lists);
    if (steps > sentenceLimits.grammarSteps) {
      options.log(
        `speech: the home's ${language} sentences take about ${steps} steps to learn, over ${sentenceLimits.grammarSteps}; keeping what it learned`,
      );
      return null;
    }
    return { language, templates: usable, lists };
  }

  async function connection(signal: AbortSignal) {
    signal.throwIfAborted();
    const found = await options.manager
      .serviceConnection(wordsService, signal)
      .catch(() => null);
    const endpoint = found ? endpointOf(found.url) : null;
    return endpoint && found?.token
      ? { ...endpoint, token: found.token }
      : null;
  }

  // Teaches the current lesson once the service runs, looking again while
  // it starts.
  async function teach() {
    if (!running || !admitted) return;
    clearTimeout(looking);
    looking = undefined;
    teaching?.abort();
    teaching = null;
    const now = lesson() ?? (recovering ? learned : null);
    if (!now) return;
    const controller = new AbortController();
    teaching = controller;
    try {
      const at = await connection(controller.signal);
      if (controller.signal.aborted) return;
      if (!at) {
        looking = setTimeout(() => void teach(), lookEveryMs).unref();
        return;
      }
      await train({
        ...at,
        lesson: now,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      learned = now;
      recovering = false;
    } catch (error) {
      if (controller.signal.aborted) return;
      options.log(
        `speech: speech recognition didn't learn the home's sentences (${error instanceof Error ? error.message : String(error)}); trying again`,
      );
      looking = setTimeout(() => void teach(), lookEveryMs).unref();
    } finally {
      if (teaching === controller) teaching = null;
    }
  }

  function recover() {
    if (!running || !admitted || !learned || recovering) return;
    recovering = true;
    if (!teaching && !looking) void teach();
  }

  // Wants or releases the service as the home needs it, one write at a
  // time; the newest state wins.
  async function apply(delay = lookEveryMs) {
    while (running && wanted !== null) {
      const want: boolean = wanted;
      const controller = new AbortController();
      changing = controller;
      try {
        if (want) {
          await options.manager.wantServiceForCore(wordsService, {
            signal: controller.signal,
          });
          if (!controller.signal.aborted) {
            admitted = true;
            void teach();
          }
        } else {
          await options.manager.releaseServiceForCore(wordsService, {
            signal: controller.signal,
          });
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          options.log(
            `speech: speech recognition couldn't ${want ? "start" : "stop"} (${error instanceof Error ? error.message : String(error)})`,
          );
          // Memory may become available when another service or app stops.
          if (want && error instanceof ManagerRefusal && error.status === 409) {
            retryAdmission = setTimeout(
              () => void apply(Math.min(delay * 2, maxAdmissionRetryMs)),
              delay,
            ).unref();
          }
        }
      } finally {
        changing = null;
      }
      if (!controller.signal.aborted) return;
      delay = lookEveryMs;
    }
  }

  function reconcile() {
    if (!running) return;
    const want = templates() !== null && options.speakersListen();
    if (want === wanted) return;
    wanted = want;
    admitted = false;
    teaching?.abort();
    clearTimeout(retrain);
    clearTimeout(looking);
    looking = undefined;
    clearTimeout(retryAdmission);
    learned = null;
    recovering = false;
    options.onWanted?.();
    if (changing) changing.abort();
    else void apply();
  }

  return {
    start() {
      running = true;
      reconcile();
    },

    /**
     * Something the lesson or the want depends on changed: the Assistant,
     * a speaker, a name, a room, a floor, a light, a mood or the language.
     * It retrains a minute after the last one.
     */
    changed() {
      if (!running) return;
      const before = wanted;
      reconcile();
      // A newly wanted service learns its first lesson when it starts.
      if (wanted !== before) return;
      if (!wanted) return;
      clearTimeout(retrain);
      retrain = setTimeout(() => void teach(), retrainMs);
      retrain.unref();
    },

    /** Whether the core wants the service now, and Piper for its replies. */
    wanted: () => wanted === true,

    speakersChanged: reconcile,

    /** Why nothing hears a run, or null while something does. */
    notHearing(): NotHearing | null {
      if (templates() === null) return "no_sentences";
      return learned && !recovering ? null : "no_speech_to_text";
    },

    /** What hears a run's words, once speech recognition has a lesson. */
    transcriber(): Transcriber | null {
      if (!learned || recovering) return null;
      const { language } = learned;
      return async (run) => {
        const at = await connection(run.signal);
        run.signal.throwIfAborted();
        if (!at) {
          recover();
          throw new Error("Speech recognition isn't running");
        }
        try {
          return await transcribe({ ...at, ...run, language });
        } catch (error) {
          if (!run.signal.aborted && error instanceof MissingSpeechLesson)
            recover();
          throw error;
        }
      };
    },

    stop() {
      running = false;
      wanted = null;
      admitted = false;
      learned = null;
      recovering = false;
      clearTimeout(retrain);
      clearTimeout(looking);
      looking = undefined;
      clearTimeout(retryAdmission);
      changing?.abort();
      teaching?.abort();
    },
  };
}

export type Learning = ReturnType<typeof createLearning>;

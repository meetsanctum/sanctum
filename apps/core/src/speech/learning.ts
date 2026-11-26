import {
  grammarSteps,
  sentenceBlanks,
  sentenceLimits,
  type AssistantSentences,
  type RequestLanguage,
  type SentenceBlank,
} from "@meetsanctum/app-sdk";

import type { Transcriber } from "./spoken.js";
import { train, transcribe, type Lesson } from "./words.js";

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

/** Why nothing hears a speaker's run now. */
export type NotHearing = "no_sentences" | "no_speech_to_text";

type Manager = {
  serviceConnection(
    service: string,
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
  let wanted = false;
  // The lesson the service last learned, which it hears with.
  let learned: { language: RequestLanguage; digest: string } | null = null;
  let changing: AbortController | null = null;
  let teaching: AbortController | null = null;
  let retrain: NodeJS.Timeout | undefined;
  let looking: NodeJS.Timeout | undefined;

  function templates() {
    return options.sentences()?.[options.language()] ?? null;
  }

  function lesson(): Lesson | null {
    const list = templates();
    if (!list) return null;
    const names = options.names();
    const used = new Set(
      list.flatMap((template) =>
        [...template.matchAll(/\{(\w+)\}/g)].map(([, blank]) => blank!),
      ),
    );
    return {
      language: options.language(),
      templates: list,
      // Only the blanks its sentences use, each with a name at least, since
      // recognition can't learn an empty list.
      lists: Object.fromEntries(
        sentenceBlanks
          .filter((blank) => used.has(blank))
          .map((blank) => [
            blank,
            names[blank].length > 0 ? names[blank] : [`no ${blank}`],
          ]),
      ),
    };
  }

  async function connection() {
    const found = await options.manager
      .serviceConnection(wordsService)
      .catch(() => null);
    const endpoint = found ? endpointOf(found.url) : null;
    return endpoint && found?.token
      ? { ...endpoint, token: found.token }
      : null;
  }

  // Teaches the current lesson once the service runs, looking again while
  // it starts.
  async function teach() {
    clearTimeout(looking);
    teaching?.abort();
    const controller = new AbortController();
    teaching = controller;
    const now = lesson();
    if (!running || !wanted || !now) return;
    const steps = grammarSteps(now.templates, now.lists);
    if (steps > sentenceLimits.grammarSteps) {
      options.log(
        `speech: the home's ${now.language} sentences take about ${steps} steps to learn, over ${sentenceLimits.grammarSteps}; keeping what it learned`,
      );
      return;
    }
    const at = await connection();
    if (controller.signal.aborted) return;
    if (!at) {
      looking = setTimeout(() => void teach(), lookEveryMs);
      looking.unref();
      return;
    }
    try {
      const { digest } = await train({
        ...at,
        lesson: now,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      learned = { language: now.language as RequestLanguage, digest };
    } catch (error) {
      if (controller.signal.aborted) return;
      options.log(
        `speech: speech recognition didn't learn the home's sentences (${error instanceof Error ? error.message : String(error)}); trying again`,
      );
      looking = setTimeout(() => void teach(), lookEveryMs);
      looking.unref();
    }
  }

  // Wants or releases the service as the home needs it, one write at a
  // time; the newest state wins.
  async function apply(want: boolean) {
    changing?.abort();
    const controller = new AbortController();
    changing = controller;
    try {
      if (want) {
        await options.manager.wantServiceForCore(wordsService, {
          signal: controller.signal,
        });
        if (!controller.signal.aborted) void teach();
      } else {
        teaching?.abort();
        clearTimeout(looking);
        learned = null;
        await options.manager.releaseServiceForCore(wordsService, {
          signal: controller.signal,
        });
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        options.log(
          `speech: speech recognition couldn't ${want ? "start" : "stop"} (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    }
  }

  function reconcile() {
    if (!running) return;
    const want = templates() !== null && options.speakersListen();
    if (want === wanted) return;
    wanted = want;
    options.onWanted?.();
    void apply(want);
  }

  return {
    start() {
      running = true;
      wanted = false;
      reconcile();
    },

    /**
     * Something the lesson or the want depends on changed: the Assistant,
     * a speaker, a name, a room, a floor, a light, a mood or the language.
     * It retrains a minute after the last one.
     */
    changed() {
      if (!running) return;
      reconcile();
      if (!wanted) return;
      clearTimeout(retrain);
      retrain = setTimeout(() => void teach(), retrainMs);
      retrain.unref();
    },

    /** Whether the core wants the service now, and Piper for its replies. */
    wanted: () => wanted,

    /** Why nothing hears a run, or null while something does. */
    notHearing(): NotHearing | null {
      if (templates() === null) return "no_sentences";
      return learned ? null : "no_speech_to_text";
    },

    /** What hears a run's words, once speech recognition has a lesson. */
    transcriber(): Transcriber | null {
      if (!learned) return null;
      const { language } = learned;
      return async (run) => {
        const at = await connection();
        if (!at) throw new Error("Speech recognition isn't running");
        return transcribe({ ...at, ...run, language });
      };
    },

    stop() {
      running = false;
      clearTimeout(retrain);
      clearTimeout(looking);
      changing?.abort();
      teaching?.abort();
    },
  };
}

export type Learning = ReturnType<typeof createLearning>;

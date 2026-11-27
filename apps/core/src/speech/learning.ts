import {
  grammarSteps,
  sentenceBlanks,
  sentenceLimits,
  type AssistantSentences,
  type Hearing,
  type HearingFailure,
  type RequestLanguage,
  type SentenceBlank,
} from "@meetsanctum/app-sdk";

import { ManagerRefusal, type ManagerClient } from "../manager.js";
import type { Transcriber } from "./spoken.js";
import {
  describeLanguages,
  MissingSpeechLesson,
  train,
  transcribe,
  type Lesson,
} from "./words.js";

// What speech recognition knows: the core wants Speech-to-Phrase while the
// Assistant has sentences in the home's language and a smart speaker
// listens, and teaches it those sentences with the home's names filled in.
// It retrains a minute after the last change to a name, a room or floor, a
// light or a mood, and at once for a new language; until it has the new
// lesson it hears with the one it had, in its language, rather than not at
// all. A lesson too large to learn on the host isn't sent, and the one
// before stays. The Assistant's app client can read how it's doing.

/** The service the manager runs for it. */
export const wordsService = "speech-to-phrase";

/** How long after the last change it retrains. */
export const retrainAfterMs = 60_000;
/** How often it looks for the service while it starts. */
const lookEveryMs = 10_000;
const maxAdmissionRetryMs = 60_000;

/** Why nothing hears a speaker's run now. */
export type NotHearing = "no_sentences" | "no_speech_to_text";

type Manager = Pick<
  ManagerClient,
  "serviceConnection" | "wantServiceForCore" | "releaseServiceForCore"
>;

type HomeLesson = Lesson & { language: RequestLanguage };
type LessonProgress = {
  language: RequestLanguage;
  problem?: HearingFailure;
  phase?: "downloading" | "learning";
};

function endpointOf(url: string) {
  const parsed = URL.parse(url);
  const port = Number(parsed?.port);
  if (parsed?.protocol !== "tcp:" || !parsed.hostname || !port) return null;
  return { host: parsed.hostname, port };
}

export function createLearning(options: {
  manager: Manager;
  // The Assistant's sentences while it answers requests, none when it
  // brings none, or null while it doesn't answer.
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
  // How it's doing changed.
  onHearing?: (hearing: Hearing) => void;
  log: (message: string) => void;
}) {
  const retrainMs = options.retrainAfterMs ?? retrainAfterMs;
  let running = false;
  let wanted: boolean | null = null;
  let admitted = false;
  // Keep the last lesson the service acknowledged in case it loses its grammar.
  let learned: HomeLesson | null = null;
  let recovering = false;
  let admissionProblem: HearingFailure | null = null;
  let managerFailed = false;
  let progress: LessonProgress | null = null;
  const cachedLanguages = new Set<RequestLanguage>();
  let shown: string | null = null;
  let changing: AbortController | null = null;
  let teaching: AbortController | null = null;
  let submitted: RequestLanguage | null = null;
  let teachAgain = false;
  let retrain: NodeJS.Timeout | undefined;
  let looking: NodeJS.Timeout | undefined;
  let retryAdmission: NodeJS.Timeout | undefined;

  function templates() {
    return options.sentences()?.[options.language()] ?? null;
  }

  function hearing(): Hearing {
    const language = options.language();
    const failed = (failure: HearingFailure): Hearing => ({
      state: "failed",
      language,
      failure,
    });
    const sentences = options.sentences();
    if (sentences === null) return failed("assistant_off");
    if (!sentences[language]) return failed("no_sentences");
    if (!options.speakersListen()) return { state: "no_speaker", language };
    if (admissionProblem) return failed(admissionProblem);
    if (managerFailed) return failed("unavailable");
    if (
      learned?.language === language &&
      !recovering &&
      (submitted === null || submitted === language)
    ) {
      return { state: "ready", language };
    }
    const current = progress?.language === language ? progress : null;
    if (current?.problem) return failed(current.problem);
    return {
      state:
        current?.phase ??
        (cachedLanguages.has(language) ? "learning" : "downloading"),
      language,
    };
  }

  // Tells of how it's doing, once for each change.
  function notify() {
    if (!running || !options.onHearing) return;
    const now = hearing();
    const key = JSON.stringify(now);
    if (key === shown) return;
    shown = key;
    options.onHearing(now);
  }

  function lesson(status: LessonProgress): HomeLesson | null {
    const { language } = status;
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
      status.problem = "no_names";
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
      status.problem = "too_many_names";
      return null;
    }
    return { language, templates: usable, lists };
  }

  async function connection(signal: AbortSignal) {
    signal.throwIfAborted();
    const found = await options.manager
      .serviceConnection(wordsService, signal)
      .catch(() => null);
    const endpoint = found?.url ? endpointOf(found.url) : null;
    return {
      at: endpoint && found?.token ? { ...endpoint, token: found.token } : null,
      state: found?.state,
    };
  }

  // Teaches the current lesson once the service runs, looking again while
  // it starts.
  async function teach() {
    if (!running || !admitted) return;
    clearTimeout(looking);
    looking = undefined;
    if (teaching) {
      // Closing the socket doesn't stop training on the service. Let it
      // finish before submitting the newest lesson.
      teachAgain = true;
      return;
    }
    const status: LessonProgress = { language: options.language() };
    progress = status;
    const now = lesson(status) ?? (recovering ? learned : null);
    if (!now) return notify();
    const controller = new AbortController();
    teaching = controller;
    notify();
    try {
      const { at, state } = await connection(controller.signal);
      if (controller.signal.aborted || teachAgain) return;
      if (state != null) managerFailed = state === "failed";
      if (managerFailed || !at) {
        looking = setTimeout(() => void teach(), lookEveryMs).unref();
        return;
      }
      const models = await describeLanguages({
        ...at,
        signal: controller.signal,
      }).catch(() => null);
      if (controller.signal.aborted || teachAgain) return;
      // The service names only the model it has loaded; those it was taught
      // in since the core started have theirs downloaded too.
      for (const language of models ?? []) cachedLanguages.add(language);
      if (now.language === status.language) {
        status.phase = cachedLanguages.has(now.language)
          ? "learning"
          : "downloading";
      }
      submitted = now.language;
      notify();
      await train({
        ...at,
        lesson: now,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      cachedLanguages.add(now.language);
      learned = now;
      recovering = false;
    } catch (error) {
      if (controller.signal.aborted) return;
      options.log(
        `speech: speech recognition didn't learn the home's sentences (${error instanceof Error ? error.message : String(error)}); trying again`,
      );
      status.problem ??= "unavailable";
      looking = setTimeout(() => void teach(), lookEveryMs).unref();
    } finally {
      if (teaching === controller) {
        teaching = null;
        submitted = null;
        delete status.phase;
        if (teachAgain) {
          teachAgain = false;
          void teach();
        } else {
          notify();
        }
      }
    }
  }

  function recover() {
    if (!running || !admitted || !learned || recovering) return;
    recovering = true;
    notify();
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
            admissionProblem = null;
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
          const noRoom =
            error instanceof ManagerRefusal && error.status === 409;
          if (want) admissionProblem = noRoom ? "memory" : "unavailable";
          notify();
          // Memory may become available when another service or app stops.
          if (want && noRoom) {
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
    const sentences = options.sentences();
    const want =
      options.speakersListen() &&
      sentences !== null &&
      (sentences[options.language()] !== undefined || learned !== null);
    if (want === wanted) return notify();
    wanted = want;
    admitted = false;
    teaching?.abort();
    teaching = null;
    submitted = null;
    teachAgain = false;
    clearTimeout(retrain);
    clearTimeout(looking);
    looking = undefined;
    clearTimeout(retryAdmission);
    learned = null;
    recovering = false;
    admissionProblem = null;
    managerFailed = false;
    progress = null;
    notify();
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
     * a speaker, a name, a room, a floor, a light or a mood. It retrains a
     * minute after the last one.
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

    /**
     * The home's language changed: it learns the new one at once, and hears
     * in the old one until then.
     */
    languageChanged() {
      if (!running) return;
      const before = wanted;
      reconcile();
      if (wanted !== before || !wanted) return;
      clearTimeout(retrain);
      void teach();
    },

    /** How speech recognition is doing, in the home's language. */
    hearing,

    /** The language it hears in now, or null while it hears in none. */
    hearsIn: (): RequestLanguage | null =>
      learned && !recovering && !managerFailed ? learned.language : null,

    /** Whether the core wants the service now, and Piper for its replies. */
    wanted: () => wanted === true,

    speakersChanged: reconcile,

    /** Why nothing hears a run, or null while something does. */
    notHearing(): NotHearing | null {
      if (learned && !recovering && !managerFailed) return null;
      return templates() === null ? "no_sentences" : "no_speech_to_text";
    },

    /** What hears a run's words, once speech recognition has a lesson. */
    transcriber(): Transcriber | null {
      if (!learned || recovering || managerFailed) return null;
      const { language } = learned;
      return async (run) => {
        const { at } = await connection(run.signal);
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
      shown = null;
      admissionProblem = null;
      managerFailed = false;
      progress = null;
      cachedLanguages.clear();
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
      teaching = null;
      submitted = null;
      teachAgain = false;
    },
  };
}

export type Learning = ReturnType<typeof createLearning>;

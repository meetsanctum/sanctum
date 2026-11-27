import type { RequestLanguage } from "./requests.js";

// How speech recognition is doing for the home's smart speakers, in the
// home's one language, which Sanctum's Assistant chooses: the core's, for
// the Assistant's page, which reads it and follows it live.

export const hearingStates = [
  // No smart speaker in the home listens, so nothing needs to hear.
  "no_speaker",
  // Sanctum is fetching speech recognition, or the language's model.
  "downloading",
  // Speech recognition is learning the Assistant's sentences with the
  // home's names.
  "learning",
  // Smart speakers hear in the language.
  "ready",
  // It can't hear in the language; `failure` says why.
  "failed",
] as const;
export type HearingState = (typeof hearingStates)[number];

export const hearingFailures = [
  // The Assistant doesn't answer requests now: it's off, paused or not
  // allowed to act as the household's AI assistant.
  "assistant_off",
  // The Assistant has no sentences in the home's language.
  "no_sentences",
  // The home has none of the names its sentences need yet, such as a room
  // or a light.
  "no_names",
  // The home has more names than speech recognition can learn.
  "too_many_names",
  // Sanctum hasn't the memory free to run speech recognition.
  "memory",
  // Speech recognition didn't start or learn; Sanctum tries again.
  "unavailable",
] as const;
export type HearingFailure = (typeof hearingFailures)[number];

export type Hearing = {
  /** The home's selected language. */
  language: RequestLanguage;
  /** What speakers can hear now, or null while they cannot listen. */
  activeLanguage: RequestLanguage | null;
} & (
  | { state: Exclude<HearingState, "failed"> }
  | { state: "failed"; failure: HearingFailure }
);

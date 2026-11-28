import type { AssistantSentences, Hearing } from "@meetsanctum/app-sdk";
import { vi } from "vitest";

import { createLearning } from "../src/speech/learning.js";

export function learningSetup(
  fake: { url: string },
  options: {
    sentences?: AssistantSentences | null;
    listens?: boolean;
  } = {},
) {
  let sentences: AssistantSentences | null =
    options.sentences === undefined
      ? { en: ["turn (on|off) the {room} lights", "turn on [the] {light}"] }
      : options.sentences;
  let listens = options.listens ?? true;
  let language: "en" | "de" = "en";
  const names = {
    room: ["Office", "Kitchen"],
    floor: ["Upstairs"],
    light: ["Desk Lamp"],
    mood: [] as string[],
  };
  const calls: string[] = [];
  let state = "running";
  const manager = {
    serviceConnection: vi.fn(async () => ({
      state,
      url: state === "running" ? fake.url : null,
      token: state === "running" ? "secret" : null,
    })),
    wantServiceForCore: vi.fn(async (name: string) => {
      calls.push(`want ${name}`);
    }),
    releaseServiceForCore: vi.fn(async (name: string) => {
      calls.push(`release ${name}`);
    }),
  };
  const logs: string[] = [];
  const hearings: Hearing[] = [];
  const learning = createLearning({
    manager,
    sentences: () => sentences,
    names: () => names,
    language: () => language,
    homeLanguage: () => language,
    speakersListen: () => listens,
    retrainAfterMs: 200,
    onHearing: (hearing) => hearings.push(hearing),
    log: (line) => logs.push(line),
  });
  return {
    learning,
    hearings,
    calls,
    names,
    logs,
    manager,
    setSentences: (next: AssistantSentences | null) => (sentences = next),
    setListens: (next: boolean) => (listens = next),
    setLanguage: (next: "en" | "de") => (language = next),
    setRunning: (next: boolean) => (state = next ? "running" : "starting"),
    setState: (next: string) => (state = next),
  };
}

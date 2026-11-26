import type { AssistantSentences } from "@meetsanctum/app-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createLearning } from "../src/speech/learning.js";
import { noVoiceMs, train, transcribe } from "../src/speech/words.js";
import { fakeSpeechToPhrase } from "./speech-support.js";

// What speech recognition knows: the core hears a run's words over
// Wyoming, and teaches the service the Assistant's sentences with the
// home's names, wanting it only while the Assistant can listen.

const servers: { close(): void }[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const server of servers.splice(0)) server.close();
});

async function service(options: Parameters<typeof fakeSpeechToPhrase>[0]) {
  const fake = await fakeSpeechToPhrase(options);
  servers.push(fake.server);
  return fake;
}

// Sound as a run has it, in 100 ms chunks, ending with listening: as fast
// as it can come, or as a speaker sends it.
function sound(chunks: number, everyMs = 5) {
  let stopped = false;
  return {
    stopListening: () => {
      stopped = true;
    },
    get stopped() {
      return stopped;
    },
    sound: (async function* () {
      for (let i = 0; i < chunks && !stopped; i += 1) {
        yield Buffer.alloc(3_200);
        await new Promise((resolve) => setTimeout(resolve, everyMs));
      }
    })(),
  };
}

describe("hearing a run's words", () => {
  it("answers the words once the service hears speech end, and stops listening", async () => {
    const fake = await service({ transcript: "turn off the office lights" });
    const run = sound(50);
    const words = await transcribe({
      host: "127.0.0.1",
      port: fake.port,
      language: "en",
      sound: run.sound,
      stopListening: run.stopListening,
      signal: new AbortController().signal,
    });
    expect(words).toBe("turn off the office lights");
    expect(run.stopped).toBe(true);
    expect(fake.heard.map((event) => event.type).slice(0, 2)).toEqual([
      "transcribe",
      "audio-start",
    ]);
    expect(fake.heard[0]!.data).toEqual({ language: "en" });
  });

  it("answers empty for speech it doesn't know", async () => {
    const fake = await service({ transcript: "" });
    const run = sound(50);
    expect(
      await transcribe({
        host: "127.0.0.1",
        port: fake.port,
        language: "en",
        sound: run.sound,
        stopListening: run.stopListening,
        signal: new AbortController().signal,
      }),
    ).toBe("");
  });

  it(
    "answers nothing heard when nobody began to speak in time",
    { timeout: 10_000 },
    async () => {
      const fake = await service({ voiceAfter: null });
      const run = sound(60, 100);
      const started = Date.now();
      expect(
        await transcribe({
          host: "127.0.0.1",
          port: fake.port,
          language: "en",
          sound: run.sound,
          stopListening: run.stopListening,
          signal: new AbortController().signal,
        }),
      ).toBeNull();
      expect(run.stopped).toBe(true);
      expect(Date.now() - started).toBeGreaterThanOrEqual(noVoiceMs - 100);
    },
  );

  it("asks for the transcript once listening ends before speech does", async () => {
    const fake = await service({ endAfter: null, transcript: "lights on" });
    const run = sound(5);
    expect(
      await transcribe({
        host: "127.0.0.1",
        port: fake.port,
        language: "en",
        sound: run.sound,
        stopListening: run.stopListening,
        signal: new AbortController().signal,
      }),
    ).toBe("lights on");
    expect(fake.heard.at(-1)?.type).toBe("audio-stop");
  });

  it("teaches a lesson with the service's token, or fails without it", async () => {
    const fake = await service({ token: "secret" });
    const lesson = {
      language: "en",
      templates: ["turn off the {room} lights"],
      lists: { room: ["Office"] },
    };
    await expect(
      train({ host: "127.0.0.1", port: fake.port, token: "secret", lesson }),
    ).resolves.toEqual({ digest: "digest-1", changed: true });
    expect(fake.lessons).toEqual([lesson]);
    await expect(
      train({ host: "127.0.0.1", port: fake.port, token: "wrong", lesson }),
    ).rejects.toThrow("valid token");
  });
});

function learningSetup(
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
  let running = true;
  const manager = {
    serviceConnection: vi.fn(async () =>
      running ? { url: fake.url, token: "secret" } : null,
    ),
    wantServiceForCore: vi.fn(async (name: string) => {
      calls.push(`want ${name}`);
    }),
    releaseServiceForCore: vi.fn(async (name: string) => {
      calls.push(`release ${name}`);
    }),
  };
  const logs: string[] = [];
  const learning = createLearning({
    manager,
    sentences: () => sentences,
    names: () => names,
    language: () => language,
    speakersListen: () => listens,
    retrainAfterMs: 200,
    log: (line) => logs.push(line),
  });
  return {
    learning,
    calls,
    names,
    logs,
    manager,
    setSentences: (next: AssistantSentences | null) => (sentences = next),
    setListens: (next: boolean) => (listens = next),
    setLanguage: (next: "en" | "de") => (language = next),
    setRunning: (next: boolean) => (running = next),
  };
}

describe("what speech recognition learns", () => {
  it("wants the service while the Assistant has sentences and a speaker listens, and teaches it the home's names", async () => {
    const fake = await service({});
    const { learning, calls } = learningSetup(fake);
    expect(learning.notHearing()).toBe("no_speech_to_text");
    learning.start();

    await vi.waitFor(() => expect(fake.lessons).toHaveLength(1));
    expect(calls).toEqual(["want speech-to-phrase"]);
    expect(fake.lessons[0]).toEqual({
      language: "en",
      templates: ["turn (on|off) the {room} lights", "turn on [the] {light}"],
      // Only the blanks its sentences use.
      lists: { room: ["Office", "Kitchen"], light: ["Desk Lamp"] },
    });
    expect(learning.wanted()).toBe(true);
    expect(learning.notHearing()).toBeNull();
    expect(learning.transcriber()).toBeTypeOf("function");
    learning.stop();
  });

  it("wants nothing while no speaker listens or the Assistant has no sentences in the home's language", async () => {
    const fake = await service({});
    const quiet = learningSetup(fake, { listens: false });
    quiet.learning.start();
    expect(quiet.learning.wanted()).toBe(false);
    expect(quiet.calls).toEqual([]);

    const german = learningSetup(fake);
    german.setLanguage("de");
    german.learning.start();
    expect(german.learning.wanted()).toBe(false);
    expect(german.learning.notHearing()).toBe("no_sentences");
    expect(german.learning.transcriber()).toBeNull();
  });

  it("releases the service once the Assistant goes, and hears nothing", async () => {
    const fake = await service({});
    const { learning, calls, setSentences } = learningSetup(fake);
    learning.start();
    await vi.waitFor(() => expect(fake.lessons).toHaveLength(1));

    setSentences(null);
    learning.changed();
    await vi.waitFor(() =>
      expect(calls).toEqual([
        "want speech-to-phrase",
        "release speech-to-phrase",
      ]),
    );
    expect(learning.wanted()).toBe(false);
    expect(learning.transcriber()).toBeNull();
    learning.stop();
  });

  it("retrains a while after the last change, hearing with the old lesson meanwhile", async () => {
    const fake = await service({});
    const { learning, names } = learningSetup(fake);
    learning.start();
    await vi.waitFor(() => expect(fake.lessons).toHaveLength(1));

    names.room.push("Hallway");
    learning.changed();
    await new Promise((resolve) => setTimeout(resolve, 120));
    names.light.push("Hall Light");
    learning.changed();
    await new Promise((resolve) => setTimeout(resolve, 120));
    // The second change put it off again.
    expect(fake.lessons).toHaveLength(1);
    // Still hearing with what it learned.
    expect(learning.transcriber()).toBeTypeOf("function");
    await vi.waitFor(() => expect(fake.lessons).toHaveLength(2));
    expect(fake.lessons[1]).toMatchObject({
      lists: {
        room: ["Office", "Kitchen", "Hallway"],
        light: ["Desk Lamp", "Hall Light"],
      },
    });
    learning.stop();
  });

  it("keeps what it learned when a retrain fails or is too large to learn", async () => {
    const fake = await service({});
    const { learning, names, logs, setSentences } = learningSetup(fake);
    learning.start();
    await vi.waitFor(() => expect(fake.lessons).toHaveLength(1));

    // A home whose names make the lesson too large to learn on the host.
    names.light.push(
      ...Array.from({ length: 4_000 }, (_, i) => `Light ${i} by the window`),
    );
    setSentences({
      en: Array(40).fill("turn on [the] {light}") as string[],
    });
    learning.changed();
    await vi.waitFor(() =>
      expect(logs.at(-1)).toContain("keeping what it learned"),
    );
    expect(fake.lessons).toHaveLength(1);
    expect(logs.at(-1)).toContain("keeping what it learned");
    expect(learning.transcriber()).toBeTypeOf("function");
    learning.stop();
  });

  it("looks again while the service starts", async () => {
    const fake = await service({});
    const { learning, setRunning } = learningSetup(fake);
    setRunning(false);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    learning.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(fake.lessons).toHaveLength(0);
    setRunning(true);
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(fake.lessons).toHaveLength(1));
    learning.stop();
  });
});

import type { AssistantSentences, Hearing } from "@meetsanctum/app-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManagerRefusal } from "../src/manager.js";
import { createLearning } from "../src/speech/learning.js";
import { noVoiceMs, train, transcribe } from "../src/speech/words.js";
import * as words from "../src/speech/words.js";
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
    expect(fake.heard.map((event) => event.type).slice(0, 3)).toEqual([
      "describe",
      "transcribe",
      "audio-start",
    ]);
    expect(fake.heard[1]!.data).toEqual({ language: "en" });
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
    const fake = await service({
      endAfter: null,
      transcript: "lights on",
      answerAfterStopMs: 1_200,
    });
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

  it("rejects a refused training connection", async () => {
    const fake = await fakeSpeechToPhrase();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
    await expect(
      train({
        host: "127.0.0.1",
        port: fake.port,
        token: "secret",
        lesson: { language: "en", templates: ["lights on"], lists: {} },
      }),
    ).rejects.toThrow("ECONNREFUSED");
  });

  it("rejects an already cancelled transcription before dialing", async () => {
    const run = sound(1);
    await expect(
      transcribe({
        host: "127.0.0.1",
        port: 0,
        language: "en",
        sound: run.sound,
        stopListening: run.stopListening,
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow("cancelled");
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
  const hearings: Hearing[] = [];
  const learning = createLearning({
    manager,
    sentences: () => sentences,
    names: () => names,
    language: () => language,
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
    setRunning: (next: boolean) => (running = next),
  };
}

describe("what speech recognition learns", () => {
  it("wants the service while the Assistant has sentences and a speaker listens, and teaches it the home's names", async () => {
    const fake = await service({});
    const { learning, calls } = learningSetup(fake, {
      sentences: {
        en: [
          "turn (on|off) the {room} lights",
          "turn on [the] {light}",
          "set the {floor} mood to {mood}",
        ],
      },
    });
    expect(learning.notHearing()).toBe("no_speech_to_text");
    learning.start();

    await vi.waitFor(() =>
      expect(learning.transcriber()).toBeTypeOf("function"),
    );
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

  it("skips teaching when every sentence needs a name the home lacks", async () => {
    const { learning, logs, manager } = learningSetup(
      { url: "" },
      { sentences: { en: ["set the mood to {mood}"] } },
    );
    try {
      learning.start();
      await vi.waitFor(() =>
        expect(logs.at(-1)).toContain("no usable en sentences"),
      );
      expect(manager.serviceConnection).not.toHaveBeenCalled();
      expect(learning.transcriber()).toBeNull();
    } finally {
      learning.stop();
    }
  });

  it("keeps the previous lesson when its templates lose their names", async () => {
    const teach = vi
      .spyOn(words, "train")
      .mockResolvedValue({ digest: "digest-1", changed: true });
    const { learning, logs, names } = learningSetup({
      url: "tcp://127.0.0.1:10300",
    });
    try {
      learning.start();
      await vi.waitFor(() =>
        expect(learning.transcriber()).toBeTypeOf("function"),
      );
      names.room.length = 0;
      names.light.length = 0;
      learning.changed();
      await vi.waitFor(() =>
        expect(logs.at(-1)).toContain("no usable en sentences"),
      );
      expect(teach).toHaveBeenCalledOnce();
      expect(learning.transcriber()).toBeTypeOf("function");
    } finally {
      learning.stop();
      teach.mockRestore();
    }
  });

  it("retries teaching after a speaker finds the service unavailable", async () => {
    const teach = vi
      .spyOn(words, "train")
      .mockResolvedValue({ digest: "digest-1", changed: true });
    const { learning, names, setRunning } = learningSetup({
      url: "tcp://127.0.0.1:10300",
    });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      learning.start();
      await vi.waitFor(() =>
        expect(learning.transcriber()).toBeTypeOf("function"),
      );
      setRunning(false);
      await expect(
        learning.transcriber()!({
          ...sound(5),
          language: "en",
          signal: new AbortController().signal,
        }),
      ).rejects.toThrow("Speech recognition isn't running");
      expect(learning.transcriber()).toBeNull();
      names.room.length = 0;
      names.light.length = 0;
      setRunning(true);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(teach).toHaveBeenCalledTimes(2);
      expect(teach.mock.lastCall?.[0].lesson.lists).toEqual({
        room: ["Office", "Kitchen"],
        light: ["Desk Lamp"],
      });
      expect(learning.transcriber()).toBeTypeOf("function");
    } finally {
      learning.stop();
      teach.mockRestore();
    }
  });

  it("teaches again when the same endpoint loses its grammar", async () => {
    const transcript = "turn off the office lights";
    const fake = await service({ transcript });
    const { learning } = learningSetup(fake);
    try {
      learning.start();
      await vi.waitFor(() =>
        expect(learning.transcriber()).toBeTypeOf("function"),
      );
      fake.forgetLesson();
      const run = () => ({
        ...sound(5),
        language: "en" as const,
        signal: new AbortController().signal,
      });
      await expect(learning.transcriber()!(run())).rejects.toThrow(
        "Speech recognition has no lesson",
      );
      expect(fake.heard.some((event) => event.type === "audio-start")).toBe(
        false,
      );
      await vi.waitFor(() =>
        expect(learning.transcriber()).toBeTypeOf("function"),
      );
      expect(fake.lessons).toEqual([fake.lessons[0], fake.lessons[0]]);
      await expect(learning.transcriber()!(run())).resolves.toBe(transcript);
    } finally {
      learning.stop();
    }
  });

  it("wants nothing while no speaker listens or the Assistant has no sentences in the home's language", async () => {
    const fake = { url: "" };
    const quiet = learningSetup(fake, { listens: false });
    quiet.learning.start();
    expect(quiet.learning.wanted()).toBe(false);
    expect(quiet.calls).toEqual(["release speech-to-phrase"]);

    const german = learningSetup(fake);
    german.setLanguage("de");
    german.learning.start();
    expect(german.learning.wanted()).toBe(false);
    expect(german.learning.notHearing()).toBe("no_sentences");
    expect(german.learning.transcriber()).toBeNull();
    expect(german.calls).toEqual(["release speech-to-phrase"]);
    quiet.learning.stop();
    german.learning.stop();
  });

  it("releases the service once the Assistant goes, and hears nothing", async () => {
    const fake = await service({});
    const { learning, calls, setSentences } = learningSetup(fake);
    learning.start();
    await vi.waitFor(() =>
      expect(learning.transcriber()).toBeTypeOf("function"),
    );

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
    await vi.waitFor(() =>
      expect(learning.transcriber()).toBeTypeOf("function"),
    );

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

  it("keeps what it learned when a new lesson is too large", async () => {
    const fake = await service({});
    const { learning, names, logs, setSentences } = learningSetup(fake);
    learning.start();
    await vi.waitFor(() =>
      expect(learning.transcriber()).toBeTypeOf("function"),
    );

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

  it("keeps hearing with the old lesson and retries a rejected lesson", async () => {
    let reject = false;
    const fake = await service({
      trainError: () => {
        if (!reject) return;
        reject = false;
        return "Could not teach the lesson";
      },
    });
    const { learning, names, logs } = learningSetup(fake);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      learning.start();
      await vi.waitFor(() =>
        expect(learning.transcriber()).toBeTypeOf("function"),
      );
      reject = true;
      names.room.push("Hallway");
      learning.changed();
      await vi.advanceTimersByTimeAsync(200);
      await vi.waitFor(() =>
        expect(logs.at(-1)).toContain("Could not teach the lesson"),
      );
      expect(fake.lessons).toHaveLength(1);
      expect(learning.transcriber()).toBeTypeOf("function");
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() =>
        expect(fake.lessons.at(-1)).toMatchObject({
          lists: { room: ["Office", "Kitchen", "Hallway"] },
        }),
      );
      expect(learning.transcriber()).toBeTypeOf("function");
    } finally {
      learning.stop();
    }
  });

  it("waits for a superseded start to settle before releasing the service", async () => {
    const { learning, manager, setListens } = learningSetup({ url: "" });
    let finishStart!: () => void;
    const started = new Promise<void>((resolve) => (finishStart = resolve));
    manager.wantServiceForCore.mockReturnValueOnce(started);
    learning.start();
    setListens(false);
    learning.speakersChanged();
    expect(manager.wantServiceForCore).toHaveBeenCalledWith(
      "speech-to-phrase",
      { signal: expect.objectContaining({ aborted: true }) },
    );
    expect(manager.releaseServiceForCore).not.toHaveBeenCalled();
    finishStart();
    await vi.waitFor(() =>
      expect(manager.releaseServiceForCore).toHaveBeenCalledOnce(),
    );
    expect(manager.serviceConnection).not.toHaveBeenCalled();
    learning.stop();
  });

  it("tries again when memory is unavailable and stops retrying when no speaker listens", async () => {
    const { learning, manager, setListens } = learningSetup({ url: "" });
    manager.wantServiceForCore.mockRejectedValue(
      new ManagerRefusal("Not enough memory", 409),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      learning.start();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(manager.wantServiceForCore).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(19_999);
      expect(manager.wantServiceForCore).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.wantServiceForCore).toHaveBeenCalledTimes(3);
      setListens(false);
      learning.speakersChanged();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(manager.wantServiceForCore).toHaveBeenCalledTimes(3);
      expect(manager.releaseServiceForCore).toHaveBeenCalledOnce();
    } finally {
      learning.stop();
    }
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

  it("learns a new language at once, hearing in the old one until it can", async () => {
    const fake = await service({ transcript: "turn on the office lights" });
    const sentences = {
      en: ["turn (on|off) the {room} lights"],
      de: ["schalte das licht im {room} (ein|aus)"],
    };
    const { learning, hearings, setLanguage } = learningSetup(fake, {
      sentences,
    });
    learning.start();
    await vi.waitFor(() => expect(learning.hearing().state).toBe("ready"));
    expect(hearings).toEqual([
      { state: "downloading", language: "en" },
      { state: "ready", language: "en" },
    ]);
    expect(learning.hearsIn()).toBe("en");

    setLanguage("de");
    learning.languageChanged();
    // Not a minute later: the new language is learned now.
    await vi.waitFor(() =>
      expect(fake.lessons.at(-1)).toMatchObject({ language: "de" }),
    );
    await vi.waitFor(() =>
      expect(learning.hearing()).toEqual({ state: "ready", language: "de" }),
    );
    expect(learning.hearsIn()).toBe("de");
    expect(hearings.slice(2)).toEqual([
      // The service had only English loaded.
      { state: "downloading", language: "de" },
      { state: "ready", language: "de" },
    ]);

    learning.stop();
  });

  it("only learns, with no download, in a language whose model the service has", async () => {
    const fake = await service({});
    const { learning, hearings } = learningSetup(fake);
    learning.start();
    await vi.waitFor(() => expect(learning.hearing().state).toBe("ready"));
    // The core starts again; the service kept its English model.
    learning.stop();
    hearings.length = 0;
    learning.start();
    await vi.waitFor(() => expect(learning.hearing().state).toBe("ready"));
    expect(hearings).toEqual([
      { state: "downloading", language: "en" },
      { state: "learning", language: "en" },
      { state: "ready", language: "en" },
    ]);
    learning.stop();
  });

  it("says what keeps it from hearing", async () => {
    const off = learningSetup({ url: "" }, { sentences: null });
    off.learning.start();
    expect(off.learning.hearing()).toEqual({
      state: "failed",
      language: "en",
      failure: "assistant_off",
    });
    off.learning.stop();

    const german = learningSetup({ url: "" });
    german.setLanguage("de");
    german.learning.start();
    expect(german.learning.hearing()).toMatchObject({
      failure: "no_sentences",
    });
    german.learning.stop();

    const quiet = learningSetup({ url: "" }, { listens: false });
    quiet.learning.start();
    expect(quiet.learning.hearing()).toEqual({
      state: "no_speaker",
      language: "en",
    });
    quiet.learning.stop();

    const nameless = learningSetup(
      { url: "" },
      { sentences: { en: ["set the mood to {mood}"] } },
    );
    nameless.learning.start();
    await vi.waitFor(() =>
      expect(nameless.learning.hearing()).toMatchObject({
        failure: "no_names",
      }),
    );
    nameless.learning.stop();

    const full = learningSetup({ url: "" });
    full.manager.wantServiceForCore.mockRejectedValue(
      new ManagerRefusal("Not enough memory", 409),
    );
    full.learning.start();
    await vi.waitFor(() =>
      expect(full.learning.hearing()).toMatchObject({ failure: "memory" }),
    );
    full.learning.stop();
  });

  it("is unavailable while a lesson fails, and ready once one is learned", async () => {
    let failing = true;
    const fake = await service({
      trainError: () => (failing ? "out of space" : undefined),
    });
    const { learning } = learningSetup(fake);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      learning.start();
      await vi.waitFor(() =>
        expect(learning.hearing()).toMatchObject({ failure: "unavailable" }),
      );
      failing = false;
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.waitFor(() => expect(learning.hearing().state).toBe("ready"));
    } finally {
      learning.stop();
    }
  });
});

import { afterEach, describe, expect, it } from "vitest";

import { noVoiceMs, train, transcribe } from "../src/speech/words.js";
import { fakeSpeechToPhrase, speechSound } from "./speech-support.js";

const servers: { close(): void }[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

async function service(options: Parameters<typeof fakeSpeechToPhrase>[0]) {
  const fake = await fakeSpeechToPhrase(options);
  servers.push(fake.server);
  return fake;
}

describe("hearing a run's words", () => {
  it("answers the words once the service hears speech end, and stops listening", async () => {
    const fake = await service({ transcript: "turn off the office lights" });
    const run = speechSound(50);
    const words = await transcribe({
      host: "127.0.0.1",
      port: fake.port,
      language: "en",
      sound: run.sound,
      stopListening: run.stopListening,
      signal: new AbortController().signal,
    });
    expect(words).toEqual({ text: "turn off the office lights" });
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
    const run = speechSound(50);
    expect(
      await transcribe({
        host: "127.0.0.1",
        port: fake.port,
        language: "en",
        sound: run.sound,
        stopListening: run.stopListening,
        signal: new AbortController().signal,
      }),
    ).toEqual({ text: "" });
  });

  it(
    "answers nothing heard when nobody began to speak in time",
    { timeout: 10_000 },
    async () => {
      const fake = await service({ voiceAfter: null });
      const run = speechSound(60, 100);
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
    const run = speechSound(5);
    expect(
      await transcribe({
        host: "127.0.0.1",
        port: fake.port,
        language: "en",
        sound: run.sound,
        stopListening: run.stopListening,
        signal: new AbortController().signal,
      }),
    ).toEqual({ text: "lights on" });
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
    const run = speechSound(1);
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

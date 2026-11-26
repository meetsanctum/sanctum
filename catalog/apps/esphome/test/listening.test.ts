import { VoiceAssistantEvent } from "esphome-client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { add, startHome } from "./support.js";
import { voicePe } from "./voice-pe.js";

// A smart speaker's requests, once the core takes them: the driver asks the
// core as the speaker hears its wake word, accepts only a run the core took,
// hands the core the microphone's sound, and shows the core's steps on the
// speaker. A speaker that can't stream over the API is declined as before.

let home: Awaited<ReturnType<typeof startHome>>;

afterEach(async () => {
  await home?.stop();
});

const declined = [
  { type: "response", isDeclined: true },
  { type: "event", eventType: VoiceAssistantEvent.RUN_END },
];

async function speaker(
  options: { streamsOverApi?: boolean } = {},
  coreOptions?: Parameters<typeof startHome>[1],
) {
  home = await startHome(undefined, coreOptions);
  const device = await voicePe(home, options);
  const key = await add(home.core, device);
  await home.core.until(() => device.voiceFollowed, "its requests followed");
  return { device, key };
}

async function taken() {
  const { device, key } = await speaker();
  home.core.listening.take();
  device.wake();
  await home.core.until(
    () => device.voiceMessages.length >= 3,
    "its run accepted",
  );
  const run = home.core.listening.latest()!;
  return { device, key, run };
}

async function waitForRunEnd(
  device: Awaited<ReturnType<typeof voicePe>>,
  after = 0,
) {
  await home.core.until(
    () =>
      device.voiceMessages
        .slice(after)
        .some(
          (message) =>
            message.type === "event" &&
            message.eventType === VoiceAssistantEvent.RUN_END,
        ),
    "its speaker received the run end",
  );
}

function holdNextOpenReply() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  const beforeListenReply = vi
    .fn<() => Promise<void>>()
    .mockResolvedValue(undefined)
    .mockReturnValueOnce(waiting);
  return { beforeListenReply, release };
}

describe("a smart speaker's request", () => {
  it("asks for its microphone and is declined while the core doesn't take it", async () => {
    const { device, key } = await speaker();
    // API_AUDIO: it streams its microphone inside the connection.
    expect(device.voiceFlags).toBe(1);
    device.wake();
    await home.core.until(
      () => device.voiceMessages.length >= declined.length,
      "its run ended",
    );
    expect(device.voiceMessages).toEqual(declined);
    expect(home.core.listening.latest()).toBeNull();
    // It still says when it heard its wake word.
    await home.core.until(
      () => home.core.latest(key, "audio")?.heardAt !== undefined,
      "when it heard",
    );
  });

  it("is accepted once the core takes it, the wake word with it", async () => {
    const { device, key, run } = await taken();
    expect(run.open).toEqual({ key, wakeWord: "Okay Nabu" });
    expect(device.voiceMessages).toEqual([
      { type: "response", isDeclined: false },
      { type: "event", eventType: VoiceAssistantEvent.RUN_START },
      { type: "event", eventType: VoiceAssistantEvent.STT_START },
    ]);
  });

  it("hands the core the microphone's sound, in order", async () => {
    const { device, run } = await taken();
    device.stream(Buffer.alloc(1024, 1));
    device.stream(Buffer.alloc(1024, 2));
    await home.core.until(() => run.audio.byteLength === 2048, "its sound");
    expect([run.audio[0], run.audio[2047]]).toEqual([1, 2]);
  });

  it("shows each of the core's steps on the speaker, then ends the run", async () => {
    const { device, run } = await taken();
    const { listening } = home.core;
    listening.step(run.id, { step: "stopped" });
    listening.step(run.id, {
      step: "heard",
      text: "turn off the office lights",
    });
    listening.step(run.id, {
      step: "reply",
      url: "http://192.168.1.2:4180/r/abc.flac",
      text: "Done",
    });
    listening.step(run.id, { step: "done" });
    await waitForRunEnd(device);
    expect(device.voiceMessages.slice(3)).toEqual([
      { type: "event", eventType: VoiceAssistantEvent.STT_VAD_END },
      {
        type: "event",
        eventType: VoiceAssistantEvent.STT_END,
        data: { text: "turn off the office lights" },
      },
      { type: "event", eventType: VoiceAssistantEvent.INTENT_START },
      {
        type: "event",
        eventType: VoiceAssistantEvent.INTENT_END,
        data: { conversation_id: "", continue_conversation: "0" },
      },
      {
        type: "event",
        eventType: VoiceAssistantEvent.TTS_START,
        data: { text: "Done" },
      },
      {
        type: "event",
        eventType: VoiceAssistantEvent.TTS_END,
        data: { url: "http://192.168.1.2:4180/r/abc.flac" },
      },
      { type: "event", eventType: VoiceAssistantEvent.RUN_END },
    ]);
    await home.core.until(() => run.end === "done", "its run closed as done");
  });

  it("shows an error the speaker lights, but no light for nothing heard", async () => {
    const { device, run } = await taken();
    home.core.listening.step(run.id, {
      step: "error",
      error: "not-understood",
    });
    home.core.listening.step(run.id, { step: "done" });
    await waitForRunEnd(device);
    expect(device.voiceMessages.slice(3)).toEqual([
      {
        type: "event",
        eventType: VoiceAssistantEvent.ERROR,
        data: { code: "intent-not-understood", message: "not-understood" },
      },
      { type: "event", eventType: VoiceAssistantEvent.RUN_END },
    ]);
    await home.core.until(() => run.end === "done", "its run closed as done");

    const afterFirst = device.voiceMessages.length;
    device.wake();
    await home.core.until(
      () => home.core.listening.runs.size === 2,
      "a second run",
    );
    const second = home.core.listening.latest()!;
    home.core.listening.step(second.id, {
      step: "error",
      error: "nothing-heard",
    });
    home.core.listening.step(second.id, { step: "done" });
    await waitForRunEnd(device, afterFirst);
    expect(device.voiceMessages.at(-2)).toMatchObject({
      eventType: VoiceAssistantEvent.ERROR,
      data: { code: "stt-no-text-recognized" },
    });
    await home.core.until(
      () => second.end === "done",
      "its second run closed as done",
    );
  });

  it("ends the run when the speaker stops it itself", async () => {
    const { device, run } = await taken();
    home.core.listening.step(run.id, { step: "stopped" });
    await home.core.until(
      () =>
        device.voiceMessages.some(
          (message) =>
            message.type === "event" &&
            message.eventType === VoiceAssistantEvent.STT_VAD_END,
        ),
      "its speaker stopped listening",
    );
    device.stopRequest();
    await waitForRunEnd(device);
    await home.core.until(() => run.end !== null, "its run closed");
    expect(run.end).toBe("stopped");
  });

  it("closes a late acceptance when the speaker stops while opening", async () => {
    const { beforeListenReply, release } = holdNextOpenReply();
    const { device } = await speaker({}, { beforeListenReply });
    home.core.listening.take();
    device.wake();
    await home.core.until(
      () => home.core.listening.latest() !== null,
      "its run opening",
    );
    const run = home.core.listening.latest()!;

    device.stopRequest();
    await waitForRunEnd(device);
    release();

    await home.core.until(() => run.end !== null, "its late run closed");
    expect(run.end).toBe("stopped");
    expect(device.voiceMessages).toEqual([
      { type: "event", eventType: VoiceAssistantEvent.RUN_END },
    ]);
  });

  it("keeps the newer request when an older acceptance arrives late", async () => {
    const { beforeListenReply, release } = holdNextOpenReply();
    const { device } = await speaker({}, { beforeListenReply });
    home.core.listening.take();
    device.wake();
    await home.core.until(
      () => home.core.listening.latest() !== null,
      "its first run opening",
    );
    const older = home.core.listening.latest()!;

    device.wake();
    await home.core.until(
      () => device.voiceMessages.length >= 3,
      "its newer run accepted",
    );
    const newer = home.core.listening.latest()!;
    release();
    await home.core.until(
      () => older.end === "stopped",
      "its older run closed",
    );

    device.stream(Buffer.alloc(1_024, 1));
    await home.core.until(
      () => newer.audio.byteLength === 1_024,
      "its newer run received audio",
    );
    expect(older.audio.byteLength).toBe(0);
    expect(device.voiceMessages).toHaveLength(3);
  });

  it("ends the run when the speaker's connection goes", async () => {
    const { device, run } = await taken();
    device.reboot();
    await home.core.until(() => run.end !== null, "its run closed");
    expect(run.end).toBe("disconnected");
  });

  it("is declined on a speaker that can't stream over the API, and doesn't listen", async () => {
    const { device, key } = await speaker({ streamsOverApi: false });
    expect(device.voiceFlags).toBe(0);
    expect(
      home.core.registered
        .get(key)!
        .capabilities.find((part) => part.kind === "audio")?.features,
    ).toMatchObject({ listens: false });
    home.core.listening.take();
    device.wake();
    await home.core.until(
      () => device.voiceMessages.length >= declined.length,
      "its run ended",
    );
    expect(device.voiceMessages).toEqual(declined);
    expect(home.core.listening.latest()).toBeNull();
  });

  it("declines a request from an API audio device without a media player", async () => {
    home = await startHome();
    const device = await home.plugIn({
      voiceAssistant: true,
      streamsOverApi: true,
    });
    const key = await add(home.core, device);
    await home.core.until(() => device.voiceFollowed, "its requests followed");

    expect(device.voiceFlags).toBe(0);
    expect(
      home.core.registered.get(key)!.capabilities.map((part) => part.kind),
    ).toEqual(["switch"]);
    home.core.listening.take();
    device.wake();

    await waitForRunEnd(device);
    expect(device.voiceMessages).toEqual(declined);
    expect(home.core.listening.latest()).toBeNull();
  });
});

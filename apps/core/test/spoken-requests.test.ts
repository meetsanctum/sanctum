import type { ListenStep, RequestReply } from "@meetsanctum/app-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { NewActivityEntry } from "../src/activity/activity.js";
import { ActionCallError } from "../src/app-host/errors.js";
import { createListening } from "../src/speech/listening.js";
import {
  createSpokenRequests,
  oneMomentAfterMs,
  type Speaker,
} from "../src/speech/spoken.js";
import { deferredResult } from "./support.js";

// A smart speaker someone asks: the core hears its words, asks the
// Assistant for the speaker, with the speaker's room and name, and says the
// reply in the speaker's run, or "One moment" and the reply after it.

const driver = "sanctum.example";
const chunk = Buffer.alloc(3_200).toString("base64");

type Asked = Parameters<
  Parameters<typeof createSpokenRequests>[0]["requests"]["ask"]
>[0];

function setup(
  options: {
    answers?: boolean;
    heard?: string | null;
    speakers?: Record<string, Speaker>;
  } = {},
) {
  const recorded: NewActivityEntry[] = [];
  const asked: {
    request: Asked;
    answer: ReturnType<typeof deferredResult<RequestReply | null>>;
    fail: (error: unknown) => void;
  }[] = [];
  const spokenLate: unknown[] = [];
  const replied: { text: string; confirmation?: boolean }[] = [];
  const forgotten: string[] = [];
  let answers = options.answers ?? true;
  let room = true;
  let drives = true;
  const speakers: Record<string, Speaker> = options.speakers ?? {
    "device:speaker": {
      name: "Office Speaker",
      room: { id: "office", name: "Office" },
    },
    "device:kitchen": { name: "Kitchen Speaker", room: null },
  };
  const spoken = createSpokenRequests({
    // Listens to a chunk of sound, then has heard what the test says.
    transcriber: () => async (run) => {
      for await (const _chunk of run.sound) {
        run.stopListening();
      }
      return options.heard === undefined
        ? "turn off the lights"
        : options.heard;
    },
    language: () => "en",
    speaker: (device) => speakers[device] ?? null,
    drives: (by, device) => drives && by === driver && device in speakers,
    requests: {
      answers: () => answers,
      hasRoom: () => room,
      ask(request) {
        const answer = deferredResult<RequestReply | null>();
        let fail!: (error: unknown) => void;
        const failed = new Promise<never>((_, reject) => (fail = reject));
        asked.push({ request, answer, fail });
        return Promise.race([answer.promise, failed]);
      },
      forget: (key) => void forgotten.push(key),
    },
    speech: () => ({
      reply: async ({ text, confirmation }) => {
        replied.push({ text, ...(confirmation ? { confirmation } : {}) });
        return `http://192.168.1.2:4180/a/${encodeURIComponent(text)}.flac`;
      },
      speak: async (input) => void spokenLate.push(input),
    }),
    record: (entry) => void recorded.push(entry),
    log: () => {},
  });
  const listening = createListening({
    idFor: (by, key) => (by === driver ? `device:${key}` : null),
    listens: () => true,
    hearer: (device) => spoken.hearer(device),
    refused: (device, refusal) => spoken.refused(device, refusal),
    log: () => {},
  });

  // Reads a run's steps as its driver does, until it's done.
  const read = new Map<string, ListenStep[]>();
  function follow(run: string) {
    const steps: ListenStep[] = [];
    read.set(run, steps);
    void (async () => {
      while (steps.at(-1)?.step !== "done") {
        steps.push(
          ...(await listening.read(driver, { run, after: steps.length })),
        );
      }
    })();
  }

  async function wake(key = "speaker") {
    const opened = listening.open(driver, { key, wakeWord: "Okay Nabu" });
    if (!opened.accepted) return opened;
    follow(opened.run);
    listening.send(driver, { run: opened.run, audio: chunk });
    return opened;
  }

  const steps = (run: string) => read.get(run) ?? [];

  return {
    spoken,
    listening,
    recorded,
    asked,
    spokenLate,
    replied,
    forgotten,
    wake,
    steps,
    until: (check: () => boolean) =>
      vi.waitFor(() => expect(check()).toBe(true)),
    turnOff: () => (answers = false),
    full: () => (room = false),
    driverGone: () => (drives = false),
  };
}

const kinds = (steps: ListenStep[]) => steps.map((step) => step.step);
const requestLines = (recorded: NewActivityEntry[]) =>
  recorded.filter((entry) => entry.action === "device.request");

afterEach(() => {
  vi.useRealTimers();
});

describe("a smart speaker's request", () => {
  it("asks the Assistant for the speaker, with its room and name, and says the reply in its run", async () => {
    const { wake, asked, until, steps, listening, recorded, spoken } = setup();
    const opened = await wake();
    if (!opened.accepted) throw new Error(opened.refusal);
    await until(() => asked.length === 1);

    expect(asked[0]!.request).toMatchObject({
      actor: { kind: "device", id: "device:speaker" },
      key: "device:speaker",
      who: { actor: "speaker:device:speaker", clientName: "Office Speaker" },
      asked: {
        text: "turn off the lights",
        language: "en",
        room: { id: "office", name: "Office" },
        from: { kind: "speaker", name: "Office Speaker" },
      },
    });
    expect(spoken.actsFor("device:speaker")).toBe(true);
    asked[0]!.answer.resolve({ text: "Turned off the Office lights" });

    await until(() => kinds(steps(opened.run)).includes("reply"));
    expect(steps(opened.run)).toEqual([
      { step: "stopped" },
      { step: "heard", text: "turn off the lights" },
      {
        step: "reply",
        url: "http://192.168.1.2:4180/a/Turned%20off%20the%20Office%20lights.flac",
        text: "Turned off the Office lights",
      },
    ]);
    // The driver says the reply played.
    listening.close(driver, { run: opened.run, end: "played" });
    await until(() => requestLines(recorded).length === 1);
    expect(requestLines(recorded)[0]).toMatchObject({
      outcome: "ok",
      subjectId: "device:speaker",
      actor: "speaker:device:speaker",
      clientName: "Office Speaker",
      detail: {
        firstSoundMs: expect.any(Number),
        stoppedListeningMs: expect.any(Number),
        replyReadyMs: expect.any(Number),
        finishedPlayingMs: expect.any(Number),
      },
    });
    // Its request is over: the Assistant acts for it no more.
    expect(spoken.actsFor("device:speaker")).toBe(false);
  });

  it("hands speech a confirmation, which plays the success chime", async () => {
    const { wake, asked, until, replied } = setup();
    await wake();
    await until(() => asked.length === 1);
    asked[0]!.answer.resolve({
      text: "Turned off the Office lights",
      confirmation: true,
    });
    await until(() => replied.length === 1);
    expect(replied).toEqual([
      { text: "Turned off the Office lights", confirmation: true },
    ]);
  });

  it("names no room for a speaker in none", async () => {
    const { wake, asked, until } = setup();
    await wake("kitchen");
    await until(() => asked.length === 1);
    expect(asked[0]!.request.asked).toMatchObject({
      room: null,
      from: { kind: "speaker", name: "Kitchen Speaker" },
    });
  });

  it("ends the run with nothing heard, or not understood, without asking", async () => {
    for (const [heard, error] of [
      [null, "nothing-heard"],
      ["  ", "not-understood"],
    ] as const) {
      const { wake, asked, until, steps } = setup({ heard });
      const opened = await wake();
      if (!opened.accepted) throw new Error(opened.refusal);
      await until(() => steps(opened.run).some((step) => step.step === "done"));
      expect(steps(opened.run)).toContainEqual({
        step: "error",
        error,
      });
      expect(asked).toEqual([]);
    }
  });

  it("ends in an error the speaker shows when the Assistant can't answer", async () => {
    const { wake, asked, until, recorded, steps } = setup();
    const opened = await wake();
    if (!opened.accepted) throw new Error(opened.refusal);
    await until(() => asked.length === 1);
    asked[0]!.fail(new ActionCallError("unavailable"));
    await until(() => requestLines(recorded).length === 1);
    expect(steps(opened.run)).toContainEqual({
      step: "error",
      error: "failed",
    });
    expect(requestLines(recorded)[0]).toMatchObject({
      outcome: "failed",
      reason: "unavailable",
    });
  });

  it("ends the first request when a second wake word comes, and says nothing of its answer", async () => {
    const { wake, asked, until, recorded, steps } = setup();
    const first = await wake();
    if (!first.accepted) throw new Error(first.refusal);
    await until(() => asked.length === 1);
    const second = await wake();
    if (!second.accepted) throw new Error(second.refusal);
    await until(() => asked.length === 2);

    expect(steps(first.run).at(-1)).toEqual({
      step: "done",
    });
    await until(() => requestLines(recorded).length === 1);
    expect(requestLines(recorded)[0]).toMatchObject({
      outcome: "failed",
      reason: "turn_ended",
    });
    // The core's request path ends the older one; its answer has no run.
    asked[0]!.answer.resolve(null);
    asked[1]!.answer.resolve({ text: "Done" });
    await until(() => kinds(steps(second.run)).includes("reply"));
    expect(kinds(steps(first.run))).not.toContain("reply");
  });

  it("says one moment after five seconds, then the reply on the speaker", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { wake, asked, listening, until, spokenLate, recorded, steps } =
      setup();
    const opened = await wake();
    if (!opened.accepted) throw new Error(opened.refusal);
    await until(() => asked.length === 1);

    await vi.advanceTimersByTimeAsync(oneMomentAfterMs);
    await until(() => kinds(steps(opened.run)).includes("reply"));
    expect(steps(opened.run).at(-1)).toMatchObject({
      step: "reply",
      text: "One moment",
    });
    listening.close(driver, { run: opened.run, end: "played" });

    asked[0]!.answer.resolve({ text: "Turned off the Office lights" });
    await until(() => spokenLate.length === 1);
    expect(spokenLate[0]).toEqual({
      device: "device:speaker",
      text: "Turned off the Office lights",
      language: "en",
      actor: { kind: "app", id: "sanctum.assistant" },
      finishing: true,
    });
    await until(() => requestLines(recorded).length === 1);
    expect(requestLines(recorded)[0]).toMatchObject({
      outcome: "ok",
      detail: { lateReplyMs: expect.any(Number) },
    });
  });

  it("drops the answer after one moment once the speaker is asked again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { wake, asked, listening, until, spokenLate, steps } = setup();
    const first = await wake();
    if (!first.accepted) throw new Error(first.refusal);
    await until(() => asked.length === 1);
    await vi.advanceTimersByTimeAsync(oneMomentAfterMs);
    await until(() => kinds(steps(first.run)).includes("reply"));
    listening.close(driver, { run: first.run, end: "played" });

    await wake();
    await until(() => asked.length === 2);
    asked[0]!.answer.resolve({ text: "Too late" });
    await vi.advanceTimersByTimeAsync(10);
    expect(spokenLate).toEqual([]);
  });

  it("ends its request and forgets its window when the speaker is removed", async () => {
    const { wake, asked, listening, until, spoken, forgotten, steps } = setup();
    const opened = await wake();
    if (!opened.accepted) throw new Error(opened.refusal);
    await until(() => asked.length === 1);

    listening.deviceGone("device:speaker");
    spoken.deviceGone("device:speaker");

    expect(forgotten).toEqual(["device:speaker"]);
    expect(spoken.actsFor("device:speaker")).toBe(false);
    await until(() => steps(opened.run).at(-1)?.step === "done");
    expect(steps(opened.run)).toContainEqual({
      step: "error",
      error: "failed",
    });
  });

  it("acts for the speaker only while its driver still drives it", async () => {
    const { wake, asked, until, spoken, driverGone } = setup();
    await wake();
    await until(() => asked.length === 1);
    expect(spoken.actsFor("device:speaker")).toBe(true);
    driverGone();
    expect(spoken.actsFor("device:speaker")).toBe(false);
    expect(() => asked[0]!.request.check?.()).toThrow(ActionCallError);
  });

  it("declines a run, saying why, while the Assistant is off or the speaker asked too often", async () => {
    const { wake, recorded, turnOff, full, asked } = setup();
    turnOff();
    expect(await wake()).toEqual({ accepted: false, refusal: "off" });
    const declines = () =>
      recorded.filter((entry) => entry.action === "device.declined");
    expect(declines()).toEqual([
      {
        action: "device.declined",
        outcome: "refused",
        reason: "assistant_off",
        subjectId: "device:speaker",
        actor: "sanctum",
      },
    ]);

    const again = setup();
    again.full();
    expect(await again.wake()).toEqual({
      accepted: false,
      refusal: "limited",
    });
    expect(
      again.recorded.filter((entry) => entry.action === "device.declined"),
    ).toMatchObject([{ reason: "limited" }]);
    void full;
    expect(asked).toEqual([]);
  });
});

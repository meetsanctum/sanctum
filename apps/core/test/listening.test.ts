import { ActionError, type ListenStep } from "@meetsanctum/app-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createListening,
  runsAtOnce,
  type HeardRun,
} from "../src/speech/listening.js";

// Smart speakers' runs: the core takes one only when something hears it,
// hands the hearer the sound, tells the driver the hearer's steps, and
// holds the run to its limits whatever the hearer does.

const sound = (ms: number) =>
  Buffer.alloc((16_000 * 2 * ms) / 1000).toString("base64");

function setup(options: { hearing?: boolean } = {}) {
  const heard: HeardRun[] = [];
  const logs: string[] = [];
  let clock = 1_000;
  const listening = createListening({
    idFor: (driver, key) =>
      driver === "sanctum.example" && key.startsWith("speaker")
        ? `device:${key}`
        : null,
    listens: (device) => device !== "device:speaker-mute",
    hearer: () =>
      options.hearing === false ? null : (run) => void heard.push(run),
    now: () => clock,
    log: (line) => logs.push(line),
  });
  const open = (key = "speaker") => {
    const opened = listening.open("sanctum.example", {
      key,
      wakeWord: "Okay Nabu",
    });
    if (!opened.accepted) throw new Error(opened.refusal);
    return opened.run;
  };
  const read = (run: string, after = 0) =>
    listening.read("sanctum.example", { run, after });
  return {
    listening,
    heard,
    logs,
    open,
    read,
    tick: (ms: number) => (clock += ms),
  };
}

async function sounded(run: HeardRun) {
  const chunks: Buffer[] = [];
  for await (const chunk of run.sound) chunks.push(chunk);
  return Buffer.concat(chunks).byteLength;
}

const kinds = (steps: ListenStep[]) => steps.map((step) => step.step);

afterEach(() => {
  vi.useRealTimers();
});

describe("a smart speaker's run", () => {
  it("is refused while nothing hears, so the speaker declines it", () => {
    const { listening } = setup({ hearing: false });
    expect(
      listening.open("sanctum.example", { key: "speaker", wakeWord: null }),
    ).toEqual({ accepted: false, refusal: "off" });
  });

  it("is only a driver's own speaker's, one that listens", () => {
    const { listening } = setup();
    expect(() =>
      listening.open("sanctum.other", { key: "speaker", wakeWord: null }),
    ).toThrow(ActionError);
    expect(() =>
      listening.open("sanctum.example", {
        key: "speaker-mute",
        wakeWord: null,
      }),
    ).toThrow(/doesn't listen/);
    expect(() =>
      listening.open("sanctum.example", { key: "", wakeWord: null }),
    ).toThrow(/cannot take/);
  });

  it("hands its hearer the sound, in order, until listening stops", async () => {
    const { listening, heard, open, read } = setup();
    const run = open();
    const [hearing] = heard;
    expect(hearing?.wakeWord).toBe("Okay Nabu");
    listening.send("sanctum.example", { run, audio: sound(100) });
    listening.send("sanctum.example", { run, audio: sound(100) });
    hearing!.stopListening();
    // The speaker sends a little more before it stops: dropped.
    listening.send("sanctum.example", { run, audio: sound(100) });
    await expect(sounded(hearing!)).resolves.toBe(6_400);
    expect(kinds(await read(run))).toEqual(["stopped"]);
  });

  it("tells the driver the hearer's steps, the reply's moment kept", async () => {
    const { heard, open, read, tick } = setup();
    const run = open();
    const hearing = heard[0]!;
    hearing.stopListening();
    hearing.heard("turn off the office lights");
    tick(500);
    hearing.reply("http://192.168.1.2:4180/r/abc.flac", "Done");
    hearing.done();
    expect(await read(run)).toEqual([
      { step: "stopped" },
      { step: "heard", text: "turn off the office lights" },
      {
        step: "reply",
        url: "http://192.168.1.2:4180/r/abc.flac",
        text: "Done",
      },
      { step: "done" },
    ]);
    expect(hearing.moments).toMatchObject({
      heard: 1_000,
      stoppedListening: 1_000,
      replyReady: 1_500,
    });
    expect(hearing.signal.aborted).toBe(true);
  });

  it("waits a moment for a step that hasn't come", async () => {
    const { heard, open, read } = setup();
    const run = open();
    const reading = read(run, 0);
    heard[0]!.heard("lights off");
    expect(kinds(await reading)).toEqual(["heard"]);
  });

  it("stops listening after eight seconds of sound", async () => {
    const { listening, heard, open, read } = setup();
    const run = open();
    for (let i = 0; i < 32; i += 1) {
      listening.send("sanctum.example", { run, audio: sound(250) });
    }
    expect(kinds(await read(run))).toEqual(["stopped"]);
    expect(heard[0]!.moments.stoppedListening).not.toBeNull();
  });

  it("ends as nothing heard after two seconds without sound", async () => {
    vi.useFakeTimers();
    const { listening, heard, open } = setup();
    const run = open();
    listening.send("sanctum.example", { run, audio: sound(100) });
    vi.advanceTimersByTime(2_000);
    const steps = await listening.read("sanctum.example", { run, after: 0 });
    expect(steps).toEqual([
      { step: "stopped" },
      { step: "error", error: "nothing-heard" },
      { step: "done" },
    ]);
    expect(heard[0]!.signal.aborted).toBe(true);
  });

  it("ends an older run when the same speaker opens a newer one", async () => {
    const { heard, open, read } = setup();
    const older = open();
    open();
    expect(await read(older)).toEqual([
      { step: "stopped" },
      { step: "error", error: "failed" },
      { step: "done" },
    ]);
    expect(heard[0]!.signal.aborted).toBe(true);
    expect(heard[1]!.signal.aborted).toBe(false);
  });

  it("takes only a few at once in the home", () => {
    const { listening, open } = setup();
    for (let i = 0; i < runsAtOnce; i += 1) open(`speaker-${i}`);
    expect(
      listening.open("sanctum.example", { key: "speaker-x", wakeWord: null }),
    ).toEqual({ accepted: false, refusal: "limited" });
  });

  it("keeps when its reply finished playing, as the driver says", async () => {
    const { listening, heard, open, tick } = setup();
    const run = open();
    heard[0]!.reply("http://192.168.1.2:4180/r/abc.flac", "Done");
    tick(2_000);
    listening.close("sanctum.example", { run, end: "played" });
    expect(heard[0]!.ended).toBe("played");
    expect(heard[0]!.moments.finishedPlaying).toBe(3_000);
    expect(heard[0]!.signal.aborted).toBe(true);
  });

  it("isn't another driver's to send to, read or close", async () => {
    const { listening, heard, open } = setup();
    const run = open();
    expect(() =>
      listening.send("sanctum.other", { run, audio: sound(100) }),
    ).toThrow(ActionError);
    await expect(
      listening.read("sanctum.other", { run, after: 0 }),
    ).resolves.toEqual([{ step: "done" }]);
    listening.close("sanctum.other", { run, end: "stopped" });
    expect(heard[0]!.signal.aborted).toBe(false);
  });

  it("refuses sound after it's done, and reads as done once gone", async () => {
    const { listening, heard, open } = setup();
    const run = open();
    heard[0]!.done();
    expect(() =>
      listening.send("sanctum.example", { run, audio: sound(100) }),
    ).toThrow(ActionError);
    await expect(
      listening.read("sanctum.example", { run: "unknown-run", after: 0 }),
    ).resolves.toEqual([{ step: "done" }]);
  });

  it("ends with its driver, its device and the core", async () => {
    const { listening, heard, open, read } = setup();
    const a = open("speaker-a");
    const b = open("speaker-b");
    listening.driverStopped("sanctum.example");
    expect(kinds(await read(a))).toEqual(["stopped", "error", "done"]);
    expect(kinds(await read(b))).toEqual(["stopped", "error", "done"]);
    const c = open("speaker-c");
    listening.deviceGone("device:speaker-c");
    expect(kinds(await read(c))).toContain("done");
    listening.stop();
    expect(
      listening.open("sanctum.example", { key: "speaker", wakeWord: null }),
    ).toEqual({ accepted: false, refusal: "unavailable" });
    expect(heard.every((run) => run.signal.aborted)).toBe(true);
  });

  it("fails a run whose hearer throws", async () => {
    const logs: string[] = [];
    const listening = createListening({
      idFor: () => "device:speaker",
      listens: () => true,
      hearer: () => () => {
        throw new Error("broken");
      },
      log: (line) => logs.push(line),
    });
    const opened = listening.open("sanctum.example", {
      key: "speaker",
      wakeWord: null,
    });
    if (!opened.accepted) throw new Error("refused");
    expect(
      kinds(
        await listening.read("sanctum.example", { run: opened.run, after: 0 }),
      ),
    ).toEqual(["stopped", "error", "done"]);
    expect(logs[0]).toMatch(/couldn't be heard/);
  });
});

import {
  aiAssistantPermission,
  assistantAppId,
  defineAction,
  defineApp,
  moodRunSchema,
  moodType,
  registerPermission,
  type AppContext,
  type ListenStep,
  type VoiceRun,
} from "@meetsanctum/app-sdk";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import { base, running, useCleanUps } from "./app-apart-support.js";
import { fakeManager } from "./manager-support.js";
import { fakePiper, fakeSpeechToPhrase } from "./speech-support.js";
import { claimed, post, testCore } from "./support.js";

// Speech recognition in a running core: once the Assistant, with its
// sentences, runs and a smart speaker listens, the core wants
// Speech-to-Phrase and Piper, teaches Speech-to-Phrase the Assistant's
// sentences with the home's names, and hears a speaker's run with it.

useCleanUps();

it("teaches the Assistant's sentences and hears a speaker's words with them", async () => {
  const asked: string[] = [];
  const assistant = defineApp({
    ...base,
    id: assistantAppId,
    name: "Assistant",
    permissions: [
      {
        id: aiAssistantPermission,
        reason: "To do what you ask.",
        needed: true,
      },
    ],
    actions: [],
    sentences: {
      en: [
        "turn (on|off) the {room} lights",
        "turn (on|off) [the] {light}",
        "set the mood to {mood}",
      ],
    },
    async requests(_ctx, request) {
      asked.push(request.text);
      await request.reply({ text: "Done", confirmation: true });
    },
  });
  let driverCtx: AppContext | undefined;
  // It keeps moods of the standard type too, which speech recognition
  // learns by name whatever app keeps them.
  const setMood = defineAction({
    id: "example.setMood",
    title: "Set a mood",
    tier: "write",
    input: z.object({}),
    output: moodRunSchema,
    runs: moodType.id,
    async run() {
      return { switched: 0, failed: [] };
    },
  });
  const mood = (name: string) =>
    driverCtx!.entities.publish({
      type: moodType.id,
      key: "evening",
      name,
      state: {
        placeId: "office",
        icon: "moon",
        name,
        order: 0,
        active: false,
        input: {},
      },
    });
  const driver = defineApp({
    ...base,
    id: "sanctum.example",
    permissions: [
      { id: registerPermission, reason: "To register devices.", needed: true },
    ],
    actions: [setMood],
    provides: { entities: [moodType] },
    start: async (ctx) => {
      driverCtx = ctx;
      await ctx.devices.register({
        key: "speaker",
        name: "Office Speaker",
        type: "smart-speaker",
        capabilities: [
          {
            id: "audio",
            kind: "audio",
            features: { listens: true, announces: true, mutes: true },
          },
        ],
      } as never);
      await ctx.devices.register({
        key: "lamp",
        name: "Office Lamp",
        type: "light",
        capabilities: [{ id: "light", kind: "light", features: {} }],
      } as never);
    },
    driver: { command: async () => undefined },
  });

  const stp = await fakeSpeechToPhrase({
    transcript: "turn off the office lamp",
  });
  const piper = await fakePiper([]);
  try {
    const { manager } = fakeManager();
    const hostStatus = await manager.hostStatus();
    const wanted = new Set<string>();
    manager.serviceUrl = async (name) =>
      name === "piper" && wanted.has("piper") ? piper.url : null;
    manager.serviceConnection = async (name) =>
      name === "speech-to-phrase" && wanted.has(name)
        ? { state: "running", url: stp.url, token: "secret" }
        : { state: "starting", url: null, token: null };
    manager.hostStatus = async () => ({
      ...hostStatus,
      network: {
        interface: "lo",
        kind: "other",
        address: "127.0.0.1",
        cidr: "127.0.0.1/32",
        signalDbm: null,
        speedMbps: null,
      },
    });
    manager.wantServiceForCore = vi.fn(async (name: string) => {
      wanted.add(name);
    });
    manager.releaseServiceForCore = vi.fn(async (name: string) => {
      wanted.delete(name);
    });
    const core = await testCore({
      manager,
      allowed: false,
      speakerPort: 0,
      speechRetrainAfterMs: 100,
      apps: [
        { app: assistant, origin: "official" },
        { app: driver, origin: "official" },
      ],
    });
    const home = await claimed(core);
    await running(core, assistantAppId);
    await running(core, "sanctum.example");

    // The names come as they register; a change retrains a minute later.
    await vi.waitFor(
      () =>
        expect(stp.lessons[0]).toEqual({
          language: "en",
          templates: ["turn (on|off) [the] {light}"],
          // The name the core gave the lamp as it registered.
          lists: {
            light: core.devices
              .list()
              .filter((device) => device.type === "light")
              .map((device) => device.name),
          },
        }),
      { timeout: 5_000 },
    );
    expect(wanted).toEqual(new Set(["speech-to-phrase", "piper"]));

    const wake = () =>
      driverCtx!.audio.listen("speaker", { wakeWord: "Okay Nabu" });
    const run = (await vi.waitFor(async () => {
      const opened = await wake();
      expect(opened.accepted).toBe(true);
      return opened;
    })) as VoiceRun;
    expect(run.accepted).toBe(true);
    for (let i = 0; i < 3; i += 1) run.send(new Uint8Array(3_200));
    const steps: ListenStep[] = [];
    for await (const step of run.steps()) {
      steps.push(step);
      if (step.step === "reply") break;
    }
    expect(steps.slice(0, 2)).toEqual([
      { step: "stopped" },
      { step: "heard", text: "turn off the office lamp" },
    ]);
    expect(asked).toEqual(["turn off the office lamp"]);
    expect(steps.at(-1)).toMatchObject({ step: "reply", text: "Done" });
    await run.close("played");

    const room = await post(
      core,
      "/api/places/rooms/add",
      { name: "Office" },
      home,
    );
    expect(room.statusCode).toBe(200);
    const { id } = room.json() as { id: string };
    await vi.waitFor(() =>
      expect(stp.lessons.at(-1)).toMatchObject({ lists: { room: ["Office"] } }),
    );
    const renamed = await post(
      core,
      "/api/places/rooms/update",
      { id, name: "Study" },
      home,
    );
    expect(renamed.statusCode).toBe(200);
    // Wait for the rename on its own so another change can't hide a missed event.
    await vi.waitFor(() =>
      expect(stp.lessons.at(-1)).toMatchObject({ lists: { room: ["Study"] } }),
    );

    // A mood brings its sentence, and a new name retrains.
    await mood("Evening");
    await vi.waitFor(() =>
      expect(stp.lessons.at(-1)).toMatchObject({
        templates: expect.arrayContaining(["set the mood to {mood}"]),
        lists: { mood: ["Evening"] },
      }),
    );
    await mood("Movie Night");
    await vi.waitFor(() =>
      expect(stp.lessons.at(-1)).toMatchObject({
        lists: { mood: ["Movie Night"] },
      }),
    );
    await driverCtx!.entities.remove("evening");
    await vi.waitFor(() => {
      const lesson = stp.lessons.at(-1);
      expect(lesson?.templates).toEqual([
        "turn (on|off) the {room} lights",
        "turn (on|off) [the] {light}",
      ]);
      expect(lesson?.lists).not.toHaveProperty("mood");
    });

    const reportMute = (muted: boolean) =>
      driverCtx!.devices.report({
        key: "speaker",
        availability: "online",
        states: { audio: { muted } },
      });
    async function streaming() {
      const starts = stp.heard.filter(
        (event) => event.type === "audio-start",
      ).length;
      const opened = await wake();
      if (!opened.accepted) throw new Error("Speaker run refused");
      await vi.waitFor(() =>
        expect(
          stp.heard.filter((event) => event.type === "audio-start"),
        ).toHaveLength(starts + 1),
      );
      return opened;
    }
    async function expectCancelled(active: VoiceRun) {
      const collected: ListenStep[] = [];
      for await (const step of active.steps()) collected.push(step);
      expect(collected).toEqual([
        { step: "stopped" },
        { step: "error", error: "failed" },
        { step: "done" },
      ]);
    }

    const mutedRun = await streaming();
    await reportMute(true);
    await expectCancelled(mutedRun);
    await expect(wake()).resolves.toEqual({
      accepted: false,
      refusal: "unavailable",
    });
    await reportMute(false);

    const offRun = await streaming();
    const off = await post(
      core,
      `/api/apps/${assistantAppId}/off`,
      { off: true },
      home,
    );
    expect(off.statusCode).toBe(200);
    await expectCancelled(offRun);
  } finally {
    stp.server.close();
    piper.server.close();
  }
});

import {
  aiAssistantPermission,
  assistantAppId,
  defineApp,
  registerPermission,
  type AppContext,
  type ListenStep,
  type VoiceRun,
} from "@meetsanctum/app-sdk";
import { expect, it, vi } from "vitest";

import { base, running, useCleanUps } from "./app-apart-support.js";
import { fakeManager } from "./manager-support.js";
import { fakePiper, fakeSpeechToPhrase } from "./speech-support.js";
import { claimed, testCore } from "./support.js";

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
    permissions: [{ id: aiAssistantPermission, reason: "To do what you ask." }],
    actions: [],
    sentences: {
      en: ["turn (on|off) the {room} lights", "turn (on|off) [the] {light}"],
    },
    async requests(_ctx, request) {
      asked.push(request.text);
      await request.reply({ text: "Done", confirmation: true });
    },
  });
  let driverCtx: AppContext | undefined;
  const driver = defineApp({
    ...base,
    id: "sanctum.example",
    permissions: [{ id: registerPermission, reason: "For the test." }],
    actions: [],
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
            features: { listens: true, announces: true },
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
    transcript: "turn off the office lights",
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
        ? { url: stp.url, token: "secret" }
        : null;
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
      speakerPort: 0,
      apps: [
        { app: assistant, origin: "official" },
        { app: driver, origin: "official" },
      ],
    });
    await claimed(core);
    await running(core, assistantAppId);
    await running(core, "sanctum.example");

    await vi.waitFor(() => expect(stp.lessons).toHaveLength(1), {
      timeout: 5_000,
    });
    // The names come as they register; a change retrains a minute later.
    expect(stp.lessons[0]).toMatchObject({
      language: "en",
      templates: [
        "turn (on|off) the {room} lights",
        "turn (on|off) [the] {light}",
      ],
      lists: { room: ["no room"] },
    });
    expect(wanted).toEqual(new Set(["speech-to-phrase", "piper"]));

    const run = (await driverCtx!.audio.listen("speaker", {
      wakeWord: "Okay Nabu",
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
      { step: "heard", text: "turn off the office lights" },
    ]);
    expect(asked).toEqual(["turn off the office lights"]);
    expect(steps.at(-1)).toMatchObject({ step: "reply", text: "Done" });
    await run.close("played");
  } finally {
    stp.server.close();
    piper.server.close();
  }
});

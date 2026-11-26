import {
  aiAssistantPermission,
  announcePermission,
  assistantAppId,
  defineApp,
  registerPermission,
  speechListenPermission,
  type AppContext,
  type AssistantRequestCall,
  type ListenStep,
  type VoiceRun,
} from "@meetsanctum/app-sdk";
import { expect, it, vi } from "vitest";

import { base, running, useCleanUps } from "./app-apart-support.js";
import { fakeManager } from "./manager-support.js";
import { fakePiper } from "./speech-support.js";
import { claimed, deferredResult, post, testCore } from "./support.js";

// A smart speaker someone asks, end to end in a running core: its driver
// opens a run, the core hears the words, Sanctum's Assistant answers for the
// speaker with the speaker's room, and the reply is the run's to play.

useCleanUps();

it("answers a smart speaker's request through the Assistant, for the speaker, in its room", async () => {
  const asked: Omit<AssistantRequestCall, "reply" | "signal">[] = [];
  const afterPlayback = deferredResult<void>();
  const commandResult = deferredResult<unknown>();
  const assistant = defineApp({
    ...base,
    id: assistantAppId,
    name: "Assistant",
    permissions: [{ id: aiAssistantPermission, reason: "To do what you ask." }],
    actions: [],
    async requests(ctx, request) {
      if (asked.length > 0) throw new Error("Could not answer");
      const { reply: _reply, signal: _signal, ...words } = request;
      asked.push(words);
      // Its tools act for the speaker while its request lasts.
      const overview = await ctx.ai.call("home_overview");
      const rooms = (JSON.parse(overview.text) as { rooms: unknown[] }).rooms;
      await request.reply({
        text: `${rooms.length} room, from ${request.from.name}`,
      });
      await afterPlayback.promise;
      try {
        commandResult.resolve(
          await ctx.ai.call("device_command", {
            device: lampId,
            capability: "light",
            command: { on: false },
          }),
        );
      } catch (error) {
        commandResult.resolve(error);
      }
    },
  });
  let driverCtx: AppContext | undefined;
  let lampId = "";
  const driver = defineApp({
    ...base,
    id: "sanctum.example",
    permissions: [
      { id: registerPermission, reason: "To register the test devices." },
      { id: speechListenPermission, reason: "To send voice requests." },
    ],
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
      await ctx.devices.report({
        key: "lamp",
        availability: "online",
        states: { light: { on: true } },
      } as never);
    },
    driver: {
      command: async (ctx, command) => {
        await ctx.devices.report({
          key: command.key,
          availability: "online",
          states: { light: { on: false } },
        } as never);
      },
    },
  });

  const { server, url: serviceUrl } = await fakePiper([]);
  try {
    const { manager } = fakeManager();
    const hostStatus = await manager.hostStatus();
    let piperRunning = false;
    manager.serviceUrl = async () => (piperRunning ? serviceUrl : null);
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
    manager.wantServiceForCore = vi.fn(async () => {
      piperRunning = true;
    });
    manager.releaseServiceForCore = vi.fn(async () => {
      piperRunning = false;
    });
    const core = await testCore({
      manager,
      speakerPort: 0,
      apps: [
        { app: assistant, origin: "official" },
        { app: driver, origin: "official" },
      ],
      // Hears what was said once the first sound comes.
      transcriber: () => async (run) => {
        for await (const _sound of run.sound) run.stopListening();
        return "turn off the lights";
      },
    });
    const maya = await claimed(core);
    await running(core, assistantAppId);
    await running(core, "sanctum.example");
    const announcements = await post(
      core,
      "/api/agents/can-use/area",
      { id: announcePermission, on: false },
      maya,
    );
    expect(announcements.statusCode).toBe(200);
    await vi.waitFor(() => expect(piperRunning).toBe(true));
    const speaker = core.devices
      .list()
      .find((device) => device.type === "smart-speaker")!;
    lampId = core.devices.list().find((device) => device.type === "light")!.id;
    const room = (
      await post(core, "/api/places/rooms/add", { name: "Office" }, maya)
    ).json() as { id: string };
    await post(
      core,
      "/api/devices/update",
      { id: speaker.id, roomId: room.id },
      maya,
    );

    const wake = () =>
      driverCtx!.audio.listen("speaker", {
        wakeWord: "Okay Nabu",
      });
    const run = (await wake()) as VoiceRun;
    expect(run.accepted).toBe(true);
    run.send(new Uint8Array(3_200));
    const steps: ListenStep[] = [];
    for await (const step of run.steps()) {
      steps.push(step);
      if (step.step === "reply") break;
    }

    expect(asked).toEqual([
      {
        text: "turn off the lights",
        language: "en",
        room: { id: room.id, name: "Office" },
        from: { kind: "speaker", name: "Office Speaker" },
        earlier: [],
      },
    ]);
    const reply = steps.at(-1);
    if (reply?.step !== "reply") throw new Error("No reply");
    expect(reply.text).toBe("1 room, from Office Speaker");
    const audio = await fetch(reply.url);
    expect(audio.headers.get("content-type")).toBe("audio/flac");
    await audio.arrayBuffer();
    // The driver reports when the speaker finishes playing the reply.
    await run.close("played");
    const finished: ListenStep[] = [];
    for await (const step of run.steps()) finished.push(step);
    expect(finished.at(-1)).toEqual({ step: "done" });
    expect(finished.some((step) => step.step === "error")).toBe(false);

    await vi.waitFor(() =>
      expect(
        core.activity
          .recent()
          .find((entry) => entry.action === "device.request"),
      ).toMatchObject({
        outcome: "ok",
        subjectId: speaker.id,
        clientName: "Office Speaker",
        detail: {
          capability: "audio",
          capabilityKind: "audio",
          finishedPlayingMs: expect.any(Number),
        },
      }),
    );
    afterPlayback.resolve();
    const command = await commandResult.promise;
    expect(command).toHaveProperty("text");
    expect(command).not.toHaveProperty("isError", true);
    // Its tool's call is the Assistant's, asked from the speaker.
    const tools = core.activity
      .recent()
      .filter((entry) => entry.actor?.startsWith("assistant-run:"));
    expect(tools.length).toBeGreaterThan(0);
    for (const entry of tools) {
      expect(core.activityViews.info(entry).who).toMatchObject({
        kind: "agent",
        askedBy: { kind: "speaker", id: speaker.id, name: "Office Speaker" },
      });
    }

    const failed = await wake();
    if (!failed.accepted) throw new Error(failed.refusal);
    failed.send(new Uint8Array(3_200));
    const failedSteps: ListenStep[] = [];
    for await (const step of failed.steps()) failedSteps.push(step);
    expect(failedSteps).toContainEqual({ step: "error", error: "failed" });
    expect(core.activity.recent()).toContainEqual(
      expect.objectContaining({
        action: "device.request",
        outcome: "failed",
        reason: "failed",
      }),
    );
  } finally {
    afterPlayback.resolve();
    server.close();
  }
}, 12_000);

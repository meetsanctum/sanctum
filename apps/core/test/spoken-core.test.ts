import {
  aiAssistantPermission,
  assistantAppId,
  defineApp,
  registerPermission,
  type AppContext,
  type AssistantRequestCall,
  type ListenStep,
  type VoiceRun,
} from "@meetsanctum/app-sdk";
import { expect, it, vi } from "vitest";

import { base, running, useCleanUps } from "./app-apart-support.js";
import { fakeManager } from "./manager-support.js";
import { fakePiper } from "./speech-support.js";
import { claimed, post, testCore } from "./support.js";

// A smart speaker someone asks, end to end in a running core: its driver
// opens a run, the core hears the words, Sanctum's Assistant answers for the
// speaker with the speaker's room, and the reply is the run's to play.

useCleanUps();

it("answers a smart speaker's request through the Assistant, for the speaker, in its room", async () => {
  const asked: Omit<AssistantRequestCall, "reply" | "signal">[] = [];
  const assistant = defineApp({
    ...base,
    id: assistantAppId,
    name: "Assistant",
    permissions: [{ id: aiAssistantPermission, reason: "To do what you ask." }],
    actions: [],
    async requests(ctx, request) {
      const { reply: _reply, signal: _signal, ...words } = request;
      asked.push(words);
      // Its tools act for the speaker while its request lasts.
      const overview = await ctx.ai.call("home_overview");
      const rooms = (JSON.parse(overview.text) as { rooms: unknown[] }).rooms;
      const switched = await ctx.ai.call("device_command", {
        device: lampId,
        capability: "light",
        command: { on: false },
      });
      if (switched.isError) throw new Error(switched.text);
      await request.reply({
        text: `${rooms.length} room, from ${request.from.name}`,
      });
    },
  });
  let driverCtx: AppContext | undefined;
  let lampId = "";
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
    manager.serviceUrl = async () => serviceUrl;
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
    manager.wantServiceForCore = vi.fn(async () => {});
    manager.releaseServiceForCore = vi.fn(async () => {});
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

    const run = (await driverCtx!.audio.listen("speaker", {
      wakeWord: "Okay Nabu",
    })) as VoiceRun;
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
    await run.close("played");

    await vi.waitFor(() =>
      expect(
        core.activity
          .recent()
          .find((entry) => entry.action === "device.request"),
      ).toMatchObject({
        outcome: "ok",
        subjectId: speaker.id,
        clientName: "Office Speaker",
      }),
    );
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
  } finally {
    server.close();
  }
});

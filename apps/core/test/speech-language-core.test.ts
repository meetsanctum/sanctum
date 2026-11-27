import {
  aiAssistantPermission,
  assistantAppId,
  defineAction,
  defineApp,
  registerPermission,
  type AppContext,
  type AssistantRequest,
  type ListenStep,
  type VoiceRun,
} from "@meetsanctum/app-sdk";
import { expect, it, vi } from "vitest";
import { z } from "zod";

import { voices } from "../src/speech/speech.js";
import { base, running, useCleanUps } from "./app-apart-support.js";
import { openLive } from "./devices-support.js";
import { fakeManager } from "./manager-support.js";
import { fakePiper, fakeSpeechToPhrase } from "./speech-support.js";
import {
  claimed,
  deferredResult,
  get,
  post,
  sharedClient,
  testCore,
} from "./support.js";

// The home's one language for speech in a running core: the Assistant sets
// it for someone in the home, speech recognition learns it at once and
// hears in the old one until then, and requests and replies follow it. Its
// app client can read and follow the status.

useCleanUps();

async function setup(
  speech: Parameters<typeof fakeSpeechToPhrase>[0],
  beforeSetLanguage?: () => Promise<void>,
) {
  const asked: AssistantRequest[] = [];
  let assistantCtx: AppContext | undefined;
  const permission = {
    id: aiAssistantPermission,
    reason: "To do what you ask.",
    needed: true,
  };
  const setLanguage = defineAction({
    id: "assistant.language",
    title: "Language",
    tier: "write",
    input: z.object({ language: z.enum(["en", "de"]) }),
    output: z.object({}),
    run: async (ctx, { language }) => {
      await beforeSetLanguage?.();
      await ctx.speech.setLanguage(language);
      return {};
    },
  });
  const assistant = defineApp({
    ...base,
    id: assistantAppId,
    name: "Assistant",
    permissions: [permission],
    actions: [setLanguage],
    sentences: {
      en: ["turn (on|off) the {room} lights"],
      de: ["schalte das licht im {room} (ein|aus)"],
    },
    notUnderstood: {
      en: "I can only help with lights and moods",
      de: "Ich helfe nur mit Licht und Stimmungen",
    },
    start: async (ctx) => {
      assistantCtx = ctx;
    },
    async requests(_ctx, request) {
      asked.push({ text: request.text, language: request.language } as never);
      await request.reply(
        request.language === "de"
          ? { text: "Das Licht ist an." }
          : { text: "Done", confirmation: true },
      );
    },
  });
  let driverCtx: AppContext | undefined;
  const driver = defineApp({
    ...base,
    id: "sanctum.example",
    permissions: [
      { id: registerPermission, reason: "To register devices.", needed: true },
      permission,
    ],
    actions: [setLanguage],
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
    },
    driver: { command: async () => undefined },
  });

  const stp = await fakeSpeechToPhrase(speech);
  const said: unknown[] = [];
  const piper = await fakePiper(said);
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
  const room = await post(
    core,
    "/api/places/rooms/add",
    { name: "Office" },
    home,
  );
  expect(room.statusCode).toBe(200);
  await post(
    core,
    "/api/devices/update",
    {
      id: core.devices.list().find((device) => device.type === "smart-speaker")!
        .id,
      roomId: (room.json() as { id: string }).id,
    },
    home,
  );

  // A speaker's run, up to its reply or its end.
  async function ask() {
    const run = (await vi.waitFor(async () => {
      const opened = await driverCtx!.audio.listen("speaker", {
        wakeWord: "Okay Nabu",
      });
      expect(opened.accepted).toBe(true);
      return opened;
    })) as VoiceRun;
    for (let i = 0; i < 3; i += 1) run.send(new Uint8Array(3_200));
    const steps: ListenStep[] = [];
    for await (const step of run.steps()) {
      steps.push(step);
      if (step.step === "reply" || step.step === "done") break;
    }
    await run.close("played");
    return steps;
  }
  const hearing = async () =>
    (await get(core, "/api/speech/hearing", home)).json();

  return {
    core,
    home,
    stp,
    piper,
    said,
    asked,
    ask,
    hearing,
    assistantCtx: () => assistantCtx!,
    close() {
      stp.server.close();
      piper.server.close();
    },
  };
}

it("learns the language the Assistant sets at once, and asks and replies in it", async () => {
  let words = "turn on the office lights";
  const training = deferredResult<void>();
  const started = deferredResult<void>();
  const home = await setup({
    transcript: () => words,
    beforeTrain(lesson) {
      if (lesson.language === "de") {
        started.resolve();
        return training.promise;
      }
    },
  });
  const { socket, messages } = await openLive(home.core, home.home.token);
  try {
    await vi.waitFor(
      async () =>
        expect(await home.hearing()).toEqual({
          state: "ready",
          language: "en",
        }),
      { timeout: 5_000 },
    );
    expect(home.stp.lessons).toEqual([
      expect.objectContaining({ language: "en" }),
    ]);

    const set = await post(
      home.core,
      `/api/apps/${assistantAppId}/actions/assistant.language`,
      { language: "de" },
      home.home,
    );
    expect(set.statusCode).toBe(200);
    await started.promise;
    expect(await home.hearing()).toEqual({
      state: "downloading",
      language: "de",
    });
    expect(await home.ask()).toContainEqual({ step: "heard", text: words });
    expect(home.asked.at(-1)).toEqual({ text: words, language: "en" });

    training.resolve();
    await vi.waitFor(() =>
      expect(home.stp.lessons.at(-1)).toMatchObject({
        language: "de",
        templates: ["schalte das licht im {room} (ein|aus)"],
        lists: { room: ["Office"] },
      }),
    );
    await vi.waitFor(async () =>
      expect(await home.hearing()).toEqual({ state: "ready", language: "de" }),
    );
    await vi.waitFor(() =>
      expect(messages).toContainEqual({
        type: "hearing",
        hearing: { state: "ready", language: "de" },
      }),
    );

    words = "schalte das licht im office ein";
    const steps = await home.ask();
    expect(steps).toContainEqual({ step: "heard", text: words });
    expect(steps).toContainEqual({
      step: "reply",
      url: expect.any(String),
      text: "Das Licht ist an.",
    });
    expect(home.said).toContainEqual({
      type: "synthesize",
      data: { text: "Das Licht ist an.", voice: { name: voices.de } },
    });
    expect(home.asked.at(-1)).toEqual({ text: words, language: "de" });
    expect(
      home.stp.heard.filter((event) => event.type === "transcribe").at(-1)
        ?.data,
    ).toEqual({ language: "de" });

    // A typed request is in the home's language too.
    const typed = await post(
      home.core,
      "/api/assistant/ask",
      { text: "schalte das licht ein" },
      home.home,
    );
    expect(typed.statusCode).toBe(200);
    expect(home.asked.at(-1)).toEqual({
      text: "schalte das licht ein",
      language: "de",
    });
  } finally {
    training.resolve();
    socket.close();
    home.close();
  }
});

it("keeps the saved speech language when the core restarts", async () => {
  const core = await testCore();
  const home = await claimed(core);
  core.places.setLanguage({ actor: "sanctum" }, "de");
  await core.stop();

  const restarted = await testCore({ dataDir: core.dataDir });
  const response = await get(restarted, "/api/speech/hearing", home);
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ language: "de" });
});

it("says the Assistant's words for speech it doesn't know", async () => {
  const home = await setup({ transcript: "" });
  try {
    await vi.waitFor(
      async () => expect((await home.hearing()).state).toBe("ready"),
      { timeout: 5_000 },
    );
    const steps = await home.ask();
    expect(steps).toEqual([
      { step: "stopped" },
      {
        step: "reply",
        url: expect.any(String),
        text: "I can only help with lights and moods",
      },
    ]);
    expect(home.asked).toEqual([]);
  } finally {
    home.close();
  }
});

it("lets only the Assistant set the language, for someone in the home", async () => {
  const home = await setup({ transcript: "" });
  try {
    // Not on its own.
    await expect(
      home.assistantCtx().speech.setLanguage("de"),
    ).rejects.toThrow();
    // Nor a language speech doesn't know.
    const odd = await post(
      home.core,
      `/api/apps/${assistantAppId}/actions/assistant.language`,
      { language: "fr" },
      home.home,
    );
    expect(odd.statusCode).toBe(400);
    expect(home.core.apps.holds("sanctum.example")?.granted).toContain(
      aiAssistantPermission,
    );
    const other = await post(
      home.core,
      "/api/apps/sanctum.example/actions/assistant.language",
      { language: "de" },
      home.home,
    );
    expect(other.statusCode).toBe(403);
    expect((await home.hearing()).language).toBe("en");

    // Only the Assistant's page reads how speech is doing.
    const otherPage = await get(home.core, "/api/speech/hearing", {
      ...home.home,
      headers: { "x-sanctum-app": "sanctum.example" },
    });
    expect(otherPage.statusCode).toBe(403);
    const assistantPage = await get(home.core, "/api/speech/hearing", {
      ...home.home,
      headers: { "x-sanctum-app": assistantAppId },
    });
    expect(assistantPage.statusCode).toBe(200);
  } finally {
    home.close();
  }
});

it("refuses a language change after the shared client is revoked", async () => {
  const started = deferredResult<void>();
  const finish = deferredResult<void>();
  const home = await setup({}, () => {
    started.resolve();
    return finish.promise;
  });
  try {
    const shared = sharedClient(home.core);
    const set = post(
      home.core,
      `/api/apps/${assistantAppId}/actions/assistant.language`,
      { language: "de" },
      shared,
    );
    await started.promise;
    const revoked = await post(
      home.core,
      "/api/auth/clients/revoke",
      { id: shared.id },
      home.home,
    );
    expect(revoked.statusCode).toBe(200);
    finish.resolve();
    expect((await set).statusCode).toBe(403);
    expect((await home.hearing()).language).toBe("en");
  } finally {
    finish.resolve();
    home.close();
  }
});

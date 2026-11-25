import type { AiCanUse, DeviceInfo } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import type { NewActivityEntry } from "../src/activity/activity.js";
import type { AgentCaller } from "../src/app-host/gate.js";
import { createAnnounceTool } from "../src/agents/announce-tool.js";
import { AnnouncementRefused } from "../src/speech/announcements.js";
import { SpeechUnavailable } from "../src/speech/speech.js";

// The announce tool: an AI agent has Sanctum say something on a smart
// speaker while "Speak on your smart speakers" is on, a few a minute, and
// Activity keeps what was sent.

const agent: AgentCaller = {
  id: "agent-1",
  name: "Kitchen agent",
  actor: { kind: "assistant-run", id: "agent-1", onBehalfOf: "person-1" },
};

const canUse = (on: boolean): AiCanUse => ({
  areas: [{ id: "devices.announce", on, always: false }],
  offers: [],
});

function speakerDevice(
  overrides: {
    availability?: string;
    muted?: boolean;
    volume?: number;
    announces?: boolean;
  } = {},
) {
  return {
    id: "speaker",
    name: "Office Speaker",
    availability: overrides.availability ?? "online",
    capabilities: [
      {
        id: "media-media_player",
        kind: "media",
        features: {},
        observed: {
          activity: "idle",
          volume: overrides.volume ?? 40,
          muted: overrides.muted ?? false,
        },
      },
      {
        id: "audio",
        kind: "audio",
        features: {
          mutes: true,
          muteSwitch: true,
          announces: overrides.announces ?? true,
        },
      },
    ],
  } as unknown as DeviceInfo;
}

function setup(
  device = speakerDevice(),
  speak?: (
    input: Parameters<
      Parameters<typeof createAnnounceTool>[0]["speech"]["speak"]
    >[0],
  ) => Promise<boolean | void>,
  fetched = false,
) {
  const devices = [device, { ...device, id: "other" }];
  const said: unknown[] = [];
  const recorded: NewActivityEntry[] = [];
  let clock = 0;
  const tool = createAnnounceTool({
    devices: {
      list: () => devices,
      get: (id) => devices.find((device) => device.id === id) ?? null,
    },
    speech: {
      speak: async (input) => {
        said.push(input);
        const encoded = (await speak?.(input)) ?? true;
        return { encoded: Promise.resolve(encoded), fetched: () => fetched };
      },
    },
    record: (entry) => {
      recorded.push(entry);
      return "entry";
    },
    agentWho: () => ({ actor: "assistant-run:agent-1" }),
    now: () => clock,
  });
  return {
    tool,
    said,
    recorded,
    tick: (ms: number) => {
      clock += ms;
    },
    run: (input: Record<string, unknown>, on = true) =>
      tool.run(agent, input, canUse(on)),
  };
}

const errorOf = (result: { structuredContent?: unknown }) =>
  (result.structuredContent as { error?: string }).error;

describe("the announce tool", () => {
  it("is listed with the home's speakers while the area is on", () => {
    const { tool } = setup();
    expect(tool.usable(canUse(true))).toBe(true);
    expect(tool.usable(canUse(false))).toBe(false);
    const listed = tool.tool(canUse(true), { assistant: false });
    expect(listed.name).toBe("announce");
    expect(listed.description).toContain('speaker ("Office Speaker")');
    expect(
      setup(speakerDevice({ announces: false })).tool.usable(canUse(true)),
    ).toBe(false);
  });

  it("says the text on the speaker in English unless asked, and logs what was said", async () => {
    const { run, said, recorded } = setup();
    const result = await run({
      speaker: "speaker",
      text: "  Dinner's ready.  ",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toEqual({
      sentTo: "Office Speaker",
      speaker: "speaker",
    });
    expect(said).toEqual([
      {
        device: "speaker",
        text: "Dinner's ready.",
        language: "en",
        actor: agent.actor,
      },
    ]);
    expect(recorded).toEqual([
      {
        action: "device.announce",
        outcome: "ok",
        actor: "assistant-run:agent-1",
        subjectId: "speaker",
        detail: { text: "Dinner's ready.", language: "en" },
      },
    ]);
  });

  it("refuses a muted, offline or unknown speaker, and text that's too long", async () => {
    expect(
      errorOf(
        await setup(speakerDevice({ muted: true })).run({
          speaker: "speaker",
          text: "Hi",
        }),
      ),
    ).toBe("muted");
    expect(
      errorOf(
        await setup(speakerDevice({ availability: "offline" })).run({
          speaker: "speaker",
          text: "Hi",
        }),
      ),
    ).toBe("unavailable");
    const { run, said } = setup();
    expect(errorOf(await run({ speaker: "kitchen", text: "Hi" }))).toBe(
      "not_found",
    );
    expect(
      errorOf(await run({ speaker: "speaker", text: "x".repeat(301) })),
    ).toBe("invalid_input");
    expect(
      errorOf(await run({ speaker: "speaker", text: "Hi", language: "fr" })),
    ).toBe("invalid_input");
    expect(said).toEqual([]);
  });

  it("refuses while the area is off", async () => {
    const { tool } = setup();
    await expect(
      tool.run(agent, { speaker: "speaker", text: "Hi" }, canUse(false)),
    ).rejects.toMatchObject({ items: ["devices.announce"] });
  });

  it("refuses a speaker turned all the way down", async () => {
    const { run, said, recorded } = setup(speakerDevice({ volume: 0 }));
    const result = await run({ speaker: "speaker", text: "Hi" });
    expect(result.structuredContent).toEqual({
      error: "muted",
      message:
        "“Office Speaker” is turned all the way down, so nobody would hear it.",
    });
    expect(said).toEqual([]);
    expect(recorded).toEqual([]);
  });

  it("lets a speaker say four things a minute", async () => {
    const { run, tick } = setup();
    for (let i = 0; i < 4; i++) {
      expect(
        (await run({ speaker: "speaker", text: `${i}` })).isError,
      ).toBeUndefined();
    }
    expect(errorOf(await run({ speaker: "speaker", text: "5" }))).toBe(
      "limited",
    );
    tick(60_001);
    expect(
      (await run({ speaker: "speaker", text: "6" })).isError,
    ).toBeUndefined();
  });

  it("reports failed speech when encoding fails before the speaker fetches it", async () => {
    const { run, recorded } = setup(speakerDevice(), async () => false);
    expect(errorOf(await run({ speaker: "speaker", text: "Hi" }))).toBe(
      "unavailable",
    );
    expect(recorded).toEqual([]);
  });

  it("reports and logs an announcement fetched before its stream was cut short", async () => {
    const { run, recorded } = setup(speakerDevice(), async () => false, true);
    const result = await run({ speaker: "speaker", text: "Hi" });
    expect(result.structuredContent).toEqual({
      sentTo: "Office Speaker",
      speaker: "speaker",
    });
    expect(recorded).toEqual([
      {
        action: "device.announce",
        outcome: "ok",
        actor: "assistant-run:agent-1",
        subjectId: "speaker",
        detail: { text: "Hi", language: "en" },
      },
    ]);
  });

  it("reserves agent quota across speakers and returns it if dispatch fails", async () => {
    let fail!: (reason: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => (fail = reject));
    const { run, said } = setup(speakerDevice(), async ({ text }) => {
      if (text === "pending") await pending;
    });
    for (const id of ["speaker", "speaker", "speaker", "other", "other"]) {
      expect((await run({ speaker: id, text: "Hi" })).isError).toBeUndefined();
    }
    const first = run({ speaker: "speaker", text: "pending" });
    expect(errorOf(await run({ speaker: "other", text: "Hi" }))).toBe(
      "limited",
    );
    expect(said).toHaveLength(6);
    fail(new SpeechUnavailable("offline"));
    expect(errorOf(await first)).toBe("unavailable");
    expect(
      (await run({ speaker: "other", text: "Hi" })).isError,
    ).toBeUndefined();
  });

  it("answers busy, full and unavailable speech by name", async () => {
    const busy = setup(speakerDevice(), async () => {
      throw new AnnouncementRefused("busy");
    });
    expect(errorOf(await busy.run({ speaker: "speaker", text: "Hi" }))).toBe(
      "busy",
    );
    expect(busy.recorded).toEqual([]);
    const full = setup(speakerDevice(), async () => {
      throw new AnnouncementRefused("full");
    });
    expect(errorOf(await full.run({ speaker: "speaker", text: "Hi" }))).toBe(
      "limited",
    );
    const off = setup(speakerDevice(), async () => {
      throw new SpeechUnavailable("Speech isn't running on Sanctum right now");
    });
    const result = await off.run({ speaker: "speaker", text: "Hi" });
    expect(errorOf(result)).toBe("unavailable");
    expect(result.content).toEqual([
      { type: "text", text: "Speech isn't running on Sanctum right now" },
    ]);
  });
});

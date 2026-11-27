import {
  ActionError,
  requestReplySchema,
  type AiToolAnswer,
  type AssistantRequestCall,
  type RequestContext,
  type RequestLanguage,
  type RequestReply,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { app } from "../src/index.js";

// The Assistant answering requests in a turn, against tools that answer as
// the core's do: home_overview's names and ids, the lights tool's outcome
// for each light, and restore's.

const overview = {
  agent: { name: "Assistant" },
  floors: [{ id: "floor-ground", name: "Ground Floor", level: 0 }],
  rooms: [
    { id: "room-office", name: "Office", floorId: "floor-ground" },
    { id: "room-kitchen", name: "Kitchen", floorId: "floor-ground" },
  ],
  zones: [],
  devices: [
    {
      id: "device-desk",
      name: "Desk Lamp",
      roomId: "room-office",
      capabilities: [{ id: "light", kind: "light" }],
    },
    {
      id: "device-plug",
      name: "Kettle",
      roomId: "room-kitchen",
      capabilities: [{ id: "switch", kind: "switch" }],
    },
  ],
};

const json = (value: unknown): AiToolAnswer => ({
  text: JSON.stringify(value),
  isError: false,
});

const lit = (name: string, result = "sent", why?: string) => ({
  device: `device-${name}`,
  capability: "light",
  name,
  result,
  ...(why ? { why } : {}),
  state: null,
});

type Tools = Record<
  string,
  (input: Record<string, unknown>) => AiToolAnswer | Promise<AiToolAnswer>
>;

async function ask(
  text: string,
  options: {
    language?: RequestLanguage;
    from?: "speaker" | "client";
    room?: { id: string; name: string } | null;
    tools?: Tools;
    aborted?: boolean;
  } = {},
) {
  const calls: { name: string; input: Record<string, unknown> }[] = [];
  const tools: Tools = {
    home_overview: () => json(overview),
    lights: () => json({ change: "c1", lights: [lit("Desk Lamp")] }),
    restore: () =>
      json({ change: "c1", changed: [{ name: "Desk Lamp", result: "sent" }] }),
    ...options.tools,
  };
  const ctx = {
    ai: {
      list: async () => [],
      call: async (name: string, input: Record<string, unknown> = {}) => {
        calls.push({ name, input });
        return tools[name]!(input);
      },
    },
  } as unknown as RequestContext;
  const replies: RequestReply[] = [];
  const controller = new AbortController();
  if (options.aborted) controller.abort();
  const from = options.from ?? "speaker";
  const request = {
    text,
    language: options.language ?? "en",
    earlier: [],
    ...(from === "speaker"
      ? {
          from: { kind: "speaker", name: "Office Speaker" },
          room:
            options.room === undefined
              ? { id: "room-office", name: "Office" }
              : options.room,
        }
      : { from: { kind: "client", name: "Kitchen Tablet" }, room: null }),
    signal: controller.signal,
    reply: async (reply: RequestReply) => void replies.push(reply),
  } as AssistantRequestCall;
  await app.requests!(ctx, request);
  return { calls, replies };
}

describe("the Assistant's requests", () => {
  it("changes the speaker's room's lights when no named light matches", async () => {
    const { calls, replies } = await ask("turn off the lights");
    expect(calls).toEqual([
      { name: "home_overview", input: {} },
      {
        name: "lights",
        input: { place: { kind: "room", id: "room-office" }, to: "off" },
      },
    ]);
    expect(replies).toEqual([
      { text: "Office lights off.", confirmation: true },
    ]);
  });

  it.each(["speaker", "client"] as const)(
    "chooses a named light over the room lights for a %s request",
    async (from) => {
      const named = {
        ...overview,
        devices: [
          ...overview.devices,
          { ...overview.devices[0], id: "device-lights", name: "Lights" },
        ],
      };
      const { calls, replies } = await ask("turn off the lights", {
        from,
        tools: { home_overview: () => json(named) },
      });
      expect(calls.at(-1)).toEqual({
        name: "lights",
        input: {
          place: {
            kind: "lights",
            lights: [{ device: "device-lights", capability: "light" }],
          },
          to: "off",
        },
      });
      expect(replies).toEqual([{ text: "Lights off.", confirmation: true }]);
    },
  );

  it("asks which room when typed, and says when the speaker has none", async () => {
    expect(await ask("lights on", { from: "client" })).toEqual({
      calls: [{ name: "home_overview", input: {} }],
      replies: [{ text: "Which room's lights? Say the room too." }],
    });
    expect(await ask("lights on", { room: null })).toEqual({
      calls: [{ name: "home_overview", input: {} }],
      replies: [
        {
          text: "I'm not in a room yet. Choose my room in Settings, Devices.",
        },
      ],
    });
  });

  it("finds a room, a floor, the home and a light by name", async () => {
    const places = async (text: string) =>
      (await ask(text, { from: "client" })).calls.at(-1)?.input;
    expect(await places("turn on the kitchen lights")).toEqual({
      place: { kind: "room", id: "room-kitchen" },
      to: "on",
    });
    expect(
      await places("make the lights on the ground floor brighter"),
    ).toEqual({ place: { kind: "floor", id: "floor-ground" }, to: "brighter" });
    expect(await places("turn off all the lights")).toEqual({
      place: { kind: "home" },
      to: "off",
    });
    expect(await places("set the desk lamp to 30%")).toEqual({
      place: {
        kind: "lights",
        lights: [{ device: "device-desk", capability: "light" }],
      },
      set: { brightness: 30 },
    });
  });

  it("reads home_overview once for a sentence with a name", async () => {
    const { calls, replies } = await ask(
      "Set the kitchen lights to fifty percent",
    );
    expect(calls.map(({ name }) => name)).toEqual(["home_overview", "lights"]);
    expect(replies).toEqual([
      { text: "Kitchen lights at 50%.", confirmation: true },
    ]);
  });

  it.each([
    ["dim the lights", "room-office", "dimmer"],
    ["brighten the lights in the Kitchen", "room-kitchen", "brighter"],
  ])('sends the direction in "%s"', async (text, id, to) => {
    const { calls } = await ask(text);
    expect(calls.at(-1)).toEqual({
      name: "lights",
      input: { place: { kind: "room", id }, to },
    });
  });

  it.each([
    ["turn off the lights in Office", "room", "Office"],
    ["turn off the lights on Ground Floor", "floor", "Ground Floor"],
    ["turn off Desk Lamp", "light", "Desk Lamp"],
  ])(
    'asks which target for "%s" when two names match',
    async (text, kind, name) => {
      const duplicateNames = {
        floors: [
          ...overview.floors,
          { id: "floor-other", name: "Ground Floor" },
        ],
        rooms: [...overview.rooms, { id: "room-other", name: "OFFICE" }],
        devices: [
          ...overview.devices,
          { ...overview.devices[0], id: "device-other", name: "Desk Lamp" },
        ],
      };
      expect(
        await ask(text, {
          tools: { home_overview: () => json(duplicateNames) },
        }),
      ).toEqual({
        calls: [{ name: "home_overview", input: {} }],
        replies: [{ text: `Which ${kind}? More than one is named ${name}.` }],
      });
    },
  );

  it("says which lights didn't answer, and when nothing changed", async () => {
    const answering = (lights: object[]) => ({
      lights: () => json({ change: null, lights }),
    });
    expect(
      (
        await ask("lights on", {
          tools: answering([lit("Desk Lamp"), lit("Shelf", "offline")]),
        })
      ).replies,
    ).toEqual([{ text: "Some lights changed. Shelf didn't answer." }]);
    expect(
      (
        await ask("lights on", {
          tools: answering([lit("Desk Lamp", "skipped", "already")]),
        })
      ).replies,
    ).toEqual([{ text: "Office lights already on." }]);
    expect(
      (
        await ask("lights on", {
          tools: answering([
            lit("Desk Lamp", "skipped", "already"),
            lit("Shelf", "offline"),
          ]),
        })
      ).replies,
    ).toEqual([{ text: "Nothing changed. Shelf didn't answer." }]);
    expect(
      (
        await ask("lights down", {
          tools: answering([lit("Desk Lamp", "skipped", "off")]),
        })
      ).replies,
    ).toEqual([{ text: "Office lights are off." }]);
    expect(
      (
        await ask("lights down", {
          tools: answering([
            lit("Desk Lamp", "skipped", "off"),
            lit("Shelf", "skipped", "already"),
          ]),
        })
      ).replies,
    ).toEqual([{ text: "Nothing changed." }]);
    expect(
      (
        await ask("lights on", {
          tools: answering([lit("Desk Lamp", "offline")]),
        })
      ).replies,
    ).toEqual([{ text: "Office lights didn't answer." }]);
    expect((await ask("lights on", { tools: answering([]) })).replies).toEqual([
      { text: "No lights in Office." },
    ]);
  });

  it("says which lights couldn't take a brightness change", async () => {
    const { replies } = await ask("set all lights to 40%", {
      tools: {
        lights: () =>
          json({
            change: "c1",
            lights: [lit("Desk Lamp"), lit("Shelf", "skipped", "unsupported")],
          }),
      },
    });
    expect(replies).toEqual([
      { text: "Some lights changed. Shelf couldn't be changed." },
    ]);
  });

  it("counts the remaining lights when their names can't all fit in a reply", async () => {
    const offline = Array.from({ length: 34 }, (_, index) =>
      lit(`Light ${index + 1}`.padEnd(120, "*"), "offline"),
    );
    const { replies } = await ask("turn on all lights", {
      tools: {
        lights: () =>
          json({ change: "c1", lights: [lit("Desk Lamp"), ...offline] }),
      },
    });
    const reply = requestReplySchema.parse(replies[0]);
    expect(reply.text).toContain(offline[0]!.name);
    expect(reply.text).toMatch(/\band 2 more didn't answer\.$/);
    expect(reply.confirmation).toBeUndefined();
  });

  it("passes on a tool's refusal in English, and says it failed in German", async () => {
    const refused = {
      lights: () => ({
        text: "“Control lights” is switched off for AI agents in Settings, What AI Agents Can Use.",
        isError: true,
      }),
    };
    expect((await ask("lights off", { tools: refused })).replies).toEqual([
      {
        text: "“Control lights” is switched off for AI agents in Settings, What AI Agents Can Use.",
      },
    ]);
    expect(
      (await ask("Licht aus", { language: "de", tools: refused })).replies,
    ).toEqual([{ text: "Das hat nicht geklappt." }]);
  });

  it.each([
    ["changed", undefined, "A light changed in the meantime."],
    ["failed", "limited", "The device command limit blocked a restore."],
  ])(
    "reports a partial restore when an outcome is %s",
    async (result, why, reason) => {
      const response = json({
        change: "c1",
        changed: [lit("Desk Lamp"), lit("Shelf", result, why)],
      });
      const { replies } = await ask("undo", {
        tools: { restore: () => ({ ...response, isError: why === "limited" }) },
      });
      expect(replies).toEqual([
        { text: `Some lights were put back. ${reason}` },
      ]);
    },
  );

  it.each([
    ["offline", "A light is offline."],
    ["uncertain", "A light still has a command pending."],
  ])(
    "explains a failed restore when the light is %s",
    async (result, reason) => {
      const { replies } = await ask("undo", {
        tools: {
          restore: () =>
            json({ change: "c1", changed: [lit("Desk Lamp", result)] }),
        },
      });
      expect(replies).toEqual([{ text: `Nothing was put back. ${reason}` }]);
    },
  );

  it("puts back its last change", async () => {
    const { calls, replies } = await ask("put it back");
    expect(calls).toEqual([{ name: "restore", input: {} }]);
    expect(replies).toEqual([{ text: "Put back.", confirmation: true }]);
    expect(
      (
        await ask("undo", {
          tools: {
            restore: () => ({
              text: "There's no change of yours to put back: only your last 5 changes are kept, for an hour.",
              isError: true,
            }),
          },
        })
      ).replies,
    ).toEqual([{ text: "There's nothing I can put back." }]);
    expect(
      (
        await ask("undo", {
          tools: {
            restore: () =>
              json({
                change: "c1",
                changed: [{ name: "Desk Lamp", result: "changed" }],
              }),
          },
        })
      ).replies,
    ).toEqual([{ text: "Nothing put back: it changed since." }]);
  });

  it("can't set timers, and says what it does for anything else", async () => {
    expect(await ask("set a timer for five minutes")).toEqual({
      calls: [],
      replies: [{ text: "I can't set timers." }],
    });
    const { calls, replies } = await ask("play some music");
    expect(calls.map(({ name }) => name)).toEqual(["home_overview"]);
    expect(replies).toEqual([{ text: "I can only help with lights." }]);
  });

  it("answers in German", async () => {
    const küche = {
      ...overview,
      rooms: [{ id: "room-kitchen", name: "Küche", floorId: null }],
    };
    const { calls, replies } = await ask("Schalte das Licht in der Küche aus", {
      language: "de",
      tools: { home_overview: () => json(küche) },
    });
    expect(calls.at(-1)?.input).toEqual({
      place: { kind: "room", id: "room-kitchen" },
      to: "off",
    });
    expect(replies).toEqual([
      { text: "Küche: Licht aus.", confirmation: true },
    ]);
    expect(
      (await ask("stell einen Timer", { language: "de" })).replies,
    ).toEqual([{ text: "Ich kann keine Timer stellen." }]);
  });

  it("says it isn't allowed when whoever asked has left the home", async () => {
    const { replies } = await ask("lights off", {
      tools: {
        lights: () => {
          throw new ActionError("forbidden");
        },
      },
    });
    expect(replies).toEqual([{ text: "I'm not allowed to do that." }]);
  });

  it("doesn't answer a request that has ended", async () => {
    expect((await ask("lights off", { aborted: true })).replies).toEqual([]);
  });
});

describe("the Assistant's language", () => {
  it("sets the home's language for speech", async () => {
    const set: string[] = [];
    const action = app.actions.find(({ id }) => id === "assistant.language")!;
    const ctx = {
      speech: {
        setLanguage: async (language: string) => void set.push(language),
      },
    };
    await action.run(ctx as never, action.input.parse({ language: "de" }));
    expect(set).toEqual(["de"]);
    expect(() => action.input.parse({ language: "fr" })).toThrow();
  });
});

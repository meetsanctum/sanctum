import {
  type AiToolAnswer,
  type AssistantRequestCall,
  type RequestContext,
  type SpeechLanguage,
  type RequestReply,
} from "@meetsanctum/app-sdk";

import { app } from "../src/index.js";

// The Assistant answering requests in a turn, against tools that answer as
// the core's do: home_overview's names and ids, the lights tool's outcome
// for each light, and restore's.

export const overview = {
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
  notAllowed: [],
};

// The home's moods, as the entities tool lists them for AI agents.
export const mood = (key: string, name: string, placeId: string) => ({
  app: "sanctum.moods",
  appName: "Moods",
  key,
  type: "mood",
  name,
  state: { placeId, icon: "moon", name, order: 0, active: false },
});
export const moods = [
  mood("office-evening", "Evening", "room-office"),
  mood("kitchen-evening", "Evening", "room-kitchen"),
  mood("kitchen-dinner", "Dinner", "room-kitchen"),
];

export const json = (value: unknown): AiToolAnswer => ({
  text: JSON.stringify(value),
  isError: false,
});

export const lit = (name: string, result = "sent", why?: string) => ({
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

export async function ask(
  text: string,
  options: {
    language?: SpeechLanguage;
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
    entities: () => json({ entities: moods }),
    run: () => json({ type: "mood", result: { switched: 2, failed: [] } }),
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

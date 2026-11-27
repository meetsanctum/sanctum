import { z } from "zod";

import {
  capabilityKinds,
  controlPermission,
  readPermission,
  type CapabilityKind,
} from "./devices.js";
import { peopleReadPermission } from "./people.js";
import { placesReadPermission } from "./places.js";

// What AI agents can use: one list for every AI agent, decided by the
// household. An app offers some of its actions and the entity types it
// provides, each starting on or off; the core's own areas are permissions,
// in the words apps' permissions use. What an app leaves out, AI agents
// never see.

/**
 * What lets an app act as the household's AI assistant: list the tools AI
 * agents may use and call them through the core, within a turn, for whoever
 * opened it.
 */
export const aiAssistantPermission = "ai.assistant";

/** A tool's answer as the model reads it: the home's data, or why it failed. */
export type AiToolAnswer = {
  text: string;
  isError: boolean;
  /** The tool's error code, when it refused, such as `not_allowed`. */
  error?: string;
};

/** Reading the activity log: who did what, when and why. */
export const activityReadPermission = "activity.read";
/** Reading what devices reported over time. */
export const historyReadPermission = "history.read";
/**
 * Saying something out loud on a smart speaker, in the home's voice. Only AI
 * agents have it, through the core's announce tool: what an announcement
 * plays is always the core's own speech, never a recording an agent brings.
 */
export const announcePermission = "devices.announce";

/** What an app offers AI agents of one of its actions or entity types. */
export type AssistantOffer = {
  /** Whether AI agents can use it before the household says otherwise. */
  readonly starts: "on" | "off";
  /** What it does, written for an AI agent deciding whether to use it. */
  readonly description: string;
  /**
   * What else must be on for it to work, by id: an area of the core's
   * (`aiAreas`), or another of the app's own offers.
   */
  readonly needs?: readonly string[];
};

export const assistantOfferSchema = z.strictObject({
  starts: z.enum(["on", "off"]),
  description: z.string().trim().min(1).max(300),
  needs: z.array(z.string().min(1)).max(10).optional(),
});

// What an SDK before `starts` wrote: only `expose: true` offered it.
const exposed = z.strictObject({
  expose: z.boolean(),
  description: z.string().trim().min(1).max(300),
});

/**
 * An offer as any app's manifest carries it, or none. A manifest from an
 * older SDK says `{ expose, description }`: offered, starting on, only
 * where `expose` is true.
 */
export function assistantOfferOf(raw: unknown): AssistantOffer | null {
  const offer = assistantOfferSchema.safeParse(raw);
  if (offer.success) return offer.data;
  const legacy = exposed.safeParse(raw);
  return legacy.success && legacy.data.expose
    ? { starts: "on", description: legacy.data.description }
    : null;
}

/** The kinds of device AI agents may control: never a sensor's own settings. */
const aiControlKinds: readonly CapabilityKind[] = ["light", "switch"];

/**
 * The core's areas AI agents can use, by the permission each is. Control
 * includes seeing, as it does for apps, so lights have no area to see them
 * by.
 */
export const aiAreas: readonly string[] = [
  placesReadPermission,
  controlPermission("light"),
  readPermission("switch"),
  controlPermission("switch"),
  ...capabilityKinds
    .filter((kind) => !aiControlKinds.includes(kind))
    .map(readPermission),
  announcePermission,
  activityReadPermission,
  historyReadPermission,
  peopleReadPermission,
];

/** On with no switch: without rooms an AI agent can do nothing by place. */
export const aiAlwaysOn: readonly string[] = [placesReadPermission];

/** The areas on before the household says otherwise. */
export const aiAreasOnAtFirst: readonly string[] = [
  controlPermission("light"),
  readPermission("switch"),
  announcePermission,
];

/** One of the core's areas, as the household has it. */
export type AiAreaInfo = {
  id: string;
  on: boolean;
  /** On with no switch: agents need it to do anything by place. */
  always: boolean;
};

/** One app's offer, as the household has it. */
export type AiOfferInfo = {
  app: string;
  /** The action's id, or the entity type's. */
  id: string;
  kind: "action" | "entity";
  tier: "read" | "write";
  title: string;
  description: string;
  on: boolean;
  needs: string[];
  /** What it needs that's off, so AI agents can't use it while it's on. */
  missing: string[];
};

/** `GET /api/agents/can-use`: what AI agents can use. */
export type AiCanUse = { areas: AiAreaInfo[]; offers: AiOfferInfo[] };

/** `POST /api/agents/can-use/area`: switches one of the core's areas. */
export type SwitchAiArea = { id: string; on: boolean };

/** `POST /api/agents/can-use/offer`: switches one of an app's offers, by its id. */
export type SwitchAiOffer = { app: string; id: string; on: boolean };

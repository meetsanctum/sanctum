import { permissionWords, type AiCanUse } from "@meetsanctum/app-sdk";
import type { CallToolResult, Tool } from "@modelcontextprotocol/server";
import { z } from "zod";

import type { AgentCaller } from "../app-host/gate.js";
import { toolError } from "./answers.js";
import { areasPage } from "./overview.js";

// What each of the core's own tools is (core-tools.ts, announce-tool.ts):
// how it's listed, whether what it needs is switched on, and how it runs.

// Who lists the tools: an MCP client, or an assistant app acting within a
// turn, for which some tools take less.
export type Listing = { assistant: boolean };

export type CoreTool = {
  /** As listed, from what's switched on now. */
  tool: (canUse: AiCanUse, listing: Listing) => Tool;
  /** Whether it's listed: what it needs is on. */
  usable: (canUse: AiCanUse) => boolean;
  /** Why it can't be used, when it's called anyway. */
  refusal: (canUse: AiCanUse) => Refused;
  run: (
    agent: AgentCaller,
    input: Record<string, unknown>,
    canUse: AiCanUse,
  ) => Promise<CallToolResult>;
};

export const isOn = (canUse: AiCanUse, area: string) =>
  canUse.areas.some((each) => each.id === area && each.on);

const titleOf = (area: string) => permissionWords(area).title;

// A refusal of what's switched off, or isn't for AI agents, with the areas
// behind it, which the activity log names.
export class Refused extends Error {
  constructor(
    readonly answer: CallToolResult,
    readonly items: readonly string[],
  ) {
    super("refused");
  }
}

export function areasOff(areas: readonly string[]) {
  const titles = areas.map((area) => `“${titleOf(area)}”`).join(" and ");
  const are = areas.length > 1 ? "are" : "is";
  return new Refused(
    toolError(
      "not_allowed",
      `${titles} ${are} switched off for AI agents in ${areasPage}.`,
    ),
    areas,
  );
}


export const inputSchemaOf = (schema: z.ZodType): Tool["inputSchema"] => {
  const json = z.toJSONSchema(schema, { io: "input" }) as Record<
    string,
    unknown
  >;
  delete json.$schema;
  return { ...json, type: "object" };
};

import type { RequestContext } from "@meetsanctum/app-sdk";

// The tools every AI agent gets, as the Assistant calls them, and what it
// reads of their answers.

/**
 * Where the core decides what AI agents may use: the Settings page its
 * refusals and home_overview name when one of its own areas is off.
 */
export const agentsPage = "Settings, What AI Agents Can Use";

// What home_overview answers that the Assistant reads.
export type Overview = {
  floors: { id: string; name: string }[];
  rooms: { id: string; name: string; floorId?: string | null }[];
  devices: {
    id: string;
    name: string;
    roomId: string | null;
    capabilities: { id: string; kind: string; features?: unknown }[];
  }[];
  notAllowed: { title: string; where: string }[];
};

// A tool's answer, read: its JSON, or its words when it refused.
export type ToolFailure = {
  ok: false;
  words: string;
  /** The tool's code when it refused, such as `not_allowed`. */
  error?: string;
};
export type ToolResult = { ok: true; value: unknown } | ToolFailure;

export async function callTool(
  ctx: RequestContext,
  name: "home_overview" | "lights" | "restore" | "entities" | "run",
  input: Record<string, unknown>,
): Promise<ToolResult> {
  const answer = await ctx.ai.call(name, input);
  if (answer.isError) {
    try {
      // A batch interrupted by the command limit still has outcomes.
      const value = JSON.parse(answer.text) as Record<string, unknown> | null;
      const field = name === "restore" ? "changed" : "lights";
      if (
        (name === "lights" || name === "restore") &&
        Array.isArray(value?.[field])
      ) {
        return { ok: true, value };
      }
    } catch {
      // A refusal is one sentence, not JSON.
    }
    return {
      ok: false,
      words: answer.text,
      error: answer.error,
    };
  }
  return { ok: true, value: JSON.parse(answer.text) as unknown };
}

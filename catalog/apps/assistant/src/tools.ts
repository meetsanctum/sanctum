import type { RequestContext } from "@meetsanctum/app-sdk";

// The tools every AI agent gets, as the Assistant calls them, and what it
// reads of their answers.

// What home_overview answers that the Assistant reads.
export type Overview = {
  floors: { id: string; name: string }[];
  rooms: { id: string; name: string }[];
  devices: {
    id: string;
    name: string;
    roomId: string | null;
    capabilities: { id: string; kind: string }[];
  }[];
  notAllowed: { title: string; where: string }[];
};

// A tool's answer, read: its JSON, or its words when it refused.
export type ToolFailure = {
  ok: false;
  words: string;
  error?: string;
  settings?: readonly string[];
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
      settings: answer.settings,
    };
  }
  return { ok: true, value: JSON.parse(answer.text) as unknown };
}

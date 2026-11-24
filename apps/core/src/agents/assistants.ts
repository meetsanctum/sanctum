import type { Actor, AiToolAnswer, ModelTool } from "@meetsanctum/app-sdk";

import type { AgentCaller } from "../app-host/gate.js";
import { toolError } from "./answers.js";
import type { AgentLimiter, LimitedLog } from "./limits.js";
import type { AgentTools } from "./tools.js";

// An app the household lets act as its AI assistant (`ai.assistant`) is an
// AI agent for the turn someone opened by calling it: it lists and calls the
// tools MCP agents get, never its own, for whoever that is. Each app is a
// separate agent for each person or shared device it acts for, so their
// limits and changes stay apart, and all assistant apps share a home pool of
// their own beside MCP agents', so neither crowds out the other.

/** Who opens a turn: a person, or a shared device acting as the household. */
export type TurnOpener = Extract<Actor, { kind: "user" | "client" }>;

// An MCP client's id is a UUID, so an assistant's id, its app's and its
// opener's, never looks like one.
const apart = "/";

export function assistantAgentId(appId: string, who: TurnOpener) {
  return `${appId}${apart}${who.kind}:${who.id}`;
}

/** The app and the opener behind an assistant's agent id, or null for an MCP client's. */
export function assistantOf(
  agentId: string,
): { appId: string; who: TurnOpener } | null {
  const at = agentId.indexOf(apart);
  if (at < 0) return null;
  const opener = agentId.slice(at + 1);
  const colon = opener.indexOf(":");
  const kind = opener.slice(0, colon);
  const id = opener.slice(colon + 1);
  if (colon < 0 || !id || (kind !== "user" && kind !== "client")) return null;
  return { appId: agentId.slice(0, at), who: { kind, id } };
}

export function assistantAgent(
  appId: string,
  appName: string,
  who: TurnOpener,
): AgentCaller {
  const id = assistantAgentId(appId, who);
  return {
    id,
    name: appName,
    actor: { kind: "assistant-run", id, onBehalfOf: who.id },
  };
}

// `ctx.models` takes this many tools at most, each named within these
// characters and described in this many. A tool named past them, from a
// long app or action id, is left out rather than failing the whole question.
const toolsAtMost = 64;
const nameRule = /^[A-Za-z0-9_-]{1,64}$/;
const descriptionAtMost = 2_048;

const unknownTool = (name: string) =>
  answerOf(toolError("unknown_tool", `There's no tool called "${name}".`));

function answerOf(result: {
  content: readonly { type: string; text?: string }[];
  isError?: boolean;
}): AiToolAnswer {
  return {
    text: result.content
      .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
      .join("\n"),
    isError: result.isError === true,
  };
}

export function createAssistantCalls(options: {
  tools: () => AgentTools;
  appName: (appId: string) => string | undefined;
  limiter: AgentLimiter;
  logLimited: LimitedLog;
  duringCall: <T>(callId: string, work: () => Promise<T>) => Promise<T>;
  newCallId: () => string;
}) {
  return {
    /** The tools for an assistant app, in `ctx.models`' shape, but its own. */
    list(appId: string): ModelTool[] {
      return options
        .tools()
        .list({ apart: appId })
        .filter((tool) => nameRule.test(tool.name))
        .slice(0, toolsAtMost)
        .map((tool) => ({
          name: tool.name,
          description: (tool.description ?? "").slice(0, descriptionAtMost),
          input: tool.inputSchema as Record<string, unknown>,
        }));
    },

    /**
     * Calls a tool for an assistant app, for whoever opened its turn, held
     * to the limits an MCP agent's request is.
     */
    async call(
      appId: string,
      who: TurnOpener,
      name: string,
      input: Record<string, unknown>,
    ): Promise<AiToolAnswer> {
      const agent = assistantAgent(appId, options.appName(appId) ?? appId, who);
      const refusal = options.limiter.takeRequest(agent.id);
      const admitted = refusal ?? options.limiter.begin(agent.id);
      if ("limited" in admitted) {
        options.logLimited(agent.id, admitted.limited);
        return answerOf(
          toolError(
            "limited",
            "Too many calls to your home's tools just now. Try again in a minute.",
          ),
        );
      }
      try {
        const result = await options.duringCall(options.newCallId(), () =>
          options.tools().call(agent, name, input, { apart: appId }),
        );
        return result ? answerOf(result) : unknownTool(name);
      } finally {
        admitted.done();
      }
    },
  };
}

export type AssistantCalls = ReturnType<typeof createAssistantCalls>;

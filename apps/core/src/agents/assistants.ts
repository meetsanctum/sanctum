import {
  ActionError,
  type Actor,
  type AiToolAnswer,
  type ModelTool,
} from "@meetsanctum/app-sdk";

import { bindAgentToTurn, type AgentCaller } from "../app-host/gate.js";
import { modelToolLimits } from "../models/turns.js";
import { toolError } from "./answers.js";
import type { AgentLimiter, LimitedLog } from "./limits.js";
import type { AgentTools } from "./tools.js";

// An app the household lets act as its AI assistant (`ai.assistant`) is an
// AI agent for the turn someone opened by calling it or asking a smart
// speaker: it lists and calls the tools MCP agents get, never its own, for
// whoever that is. Each app is a separate agent for each person, shared
// device or smart speaker it acts for, so their limits and changes stay
// apart, and all assistant apps share a home pool of their own beside MCP
// agents', so neither crowds out the other.

/**
 * Who opens a turn: a person, a shared device acting as the household, or a
 * smart speaker someone asked, by the core's id for it. Only the core opens a
 * speaker's, from the speaker's run (speech/spoken.ts), so a speaker is never
 * an actor of a call.
 */
export type TurnOpener =
  Extract<Actor, { kind: "user" | "client" }> | { kind: "device"; id: string };

const openerKinds = new Set<string>(["user", "client", "device"]);

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
  if (colon < 0 || !id || !openerKinds.has(kind)) return null;
  return {
    appId: agentId.slice(0, at),
    who: { kind: kind as TurnOpener["kind"], id },
  };
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

const unknownTool = (name: string) =>
  answerOf(toolError("unknown_tool", `There's no tool called "${name}".`));

function answerOf(result: {
  content: readonly { type: string; text?: string }[];
  isError?: boolean;
  structuredContent?: unknown;
}): AiToolAnswer {
  const details = result.structuredContent as { error?: unknown } | null;
  const error = details?.error;
  return {
    text: result.content
      .flatMap((part) => (part.type === "text" && part.text ? [part.text] : []))
      .join("\n"),
    isError: result.isError === true,
    ...(result.isError && typeof error === "string" ? { error } : {}),
  };
}

export function createAssistantCalls(options: {
  tools: () => AgentTools;
  appName: (appId: string) => string | undefined;
  canActFor: (who: TurnOpener) => boolean;
  limiter: AgentLimiter;
  logLimited: LimitedLog;
  duringCall: <T>(callId: string, work: () => Promise<T>) => Promise<T>;
  newCallId: () => string;
}) {
  function takeRequest(appId: string, who: TurnOpener) {
    if (!options.canActFor(who)) throw new ActionError("forbidden");
    const id = assistantAgentId(appId, who);
    const refusal = options.limiter.takeRequest(id);
    if (refusal) options.logLimited(id, refusal.limited);
    return refusal;
  }

  return {
    canActFor: options.canActFor,

    /** The tools for an assistant app, in the shape accepted by `ctx.models`. */
    list(appId: string, who: TurnOpener): ModelTool[] {
      if (takeRequest(appId, who)) throw new ActionError("limited");
      return options
        .tools()
        .list({ apart: appId })
        .filter((tool) => modelToolLimits.name.test(tool.name))
        .slice(0, modelToolLimits.count)
        .map((tool) => ({
          name: tool.name,
          description: (tool.description ?? "").slice(
            0,
            modelToolLimits.description,
          ),
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
      ended: () => boolean,
      requestClientId?: string,
    ): Promise<AiToolAnswer> {
      const refusal = takeRequest(appId, who);
      const agent = assistantAgent(appId, options.appName(appId) ?? appId, who);
      if (requestClientId !== undefined)
        agent.requestClientId = requestClientId;
      const admitted = refusal ?? options.limiter.begin(agent.id);
      if ("limited" in admitted) {
        if (!refusal) options.logLimited(agent.id, admitted.limited);
        return answerOf(
          toolError(
            "limited",
            "Too many calls to your home's tools just now. Try again in a minute.",
          ),
        );
      }
      try {
        bindAgentToTurn(agent, ended);
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

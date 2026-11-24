import type {
  ModelMessage,
  ModelTool,
  ModelToolCall,
} from "@meetsanctum/app-sdk";
import type { AssistantModelMessage, ModelMessage as SdkMessage } from "ai";
import { isDeepStrictEqual } from "node:util";

import { ModelError } from "./client.js";

// An app's conversation as the AI SDK takes it. System messages before the
// first other one are the instructions; later ones go as the household's
// words, since letting a conversation set the system prompt invites
// injection. A tool result names its tool, from the call it answers.
//
// Some models think before they answer, and a tool loop has to give each
// answer back as it came, thinking included, or the model loses its
// reasoning: some current Claude models always think, and OpenAI's
// reasoning models send their reasoning sealed for the next answer. Apps
// give back only text and tool calls, so within a turn the core keeps each
// answer that called a tool, by its first call's id, and gives that back
// instead while nothing before it has changed.

export type Conversation = {
  instructions: string | undefined;
  messages: SdkMessage[];
  tools: readonly ModelTool[] | undefined;
};

/** Each answer of this turn that called a tool, as it came, by call id. */
export type KeptAnswers = Map<
  string,
  Conversation & {
    /** The answer as the app gives it back: its text and tool calls. */
    visible: AssistantModelMessage | undefined;
    answer: AssistantModelMessage;
  }
>;

function assistantOf(
  content: string,
  toolCalls: readonly ModelToolCall[] | undefined,
): AssistantModelMessage | undefined {
  const parts: AssistantModelMessage["content"] = [
    ...(content ? [{ type: "text" as const, text: content }] : []),
    ...(toolCalls ?? []).map((call) => ({
      type: "tool-call" as const,
      toolCallId: call.id,
      toolName: call.name,
      input: call.input ?? {},
    })),
  ];
  // An empty answer has nothing to give back; Anthropic refuses one.
  return parts.length > 0 ? { role: "assistant", content: parts } : undefined;
}

/** The conversation for the SDK, with the kept answers given back. */
export function conversationOf(
  messages: readonly ModelMessage[],
  tools: readonly ModelTool[] | undefined,
  kept?: KeptAnswers,
): Conversation {
  const instructions: string[] = [];
  const wire: SdkMessage[] = [];
  const toolNames = new Map<string, string>();
  let isStart = true;
  for (const message of messages) {
    if (message.role === "system" && isStart) {
      instructions.push(message.content);
      continue;
    }
    isStart = false;
    switch (message.role) {
      case "system":
      case "user":
        wire.push({ role: "user", content: message.content });
        break;
      case "tool": {
        const toolName = toolNames.get(message.toolCallId);
        if (!toolName) {
          throw new ModelError("refused", "a tool result answers no call");
        }
        wire.push({
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: message.toolCallId,
              toolName,
              output: { type: "text", value: message.content },
            },
          ],
        });
        break;
      }
      case "assistant": {
        for (const call of message.toolCalls ?? []) {
          toolNames.set(call.id, call.name);
        }
        const visible = assistantOf(message.content, message.toolCalls);
        const [first] = message.toolCalls ?? [];
        const answered = first && kept?.get(first.id);
        // A thinking block is tied to the conversation that produced it. If
        // the app edits that conversation, send the app's version on its own.
        if (
          answered &&
          answered.instructions === (instructions.join("\n\n") || undefined) &&
          isDeepStrictEqual(answered.tools, tools) &&
          isDeepStrictEqual(answered.messages, wire) &&
          isDeepStrictEqual(answered.visible, visible)
        ) {
          wire.push(answered.answer);
        } else if (visible) {
          wire.push(visible);
        }
        break;
      }
    }
  }
  return {
    instructions: instructions.join("\n\n") || undefined,
    messages: wire,
    tools,
  };
}

/** Keeps an answer that called a tool, to give back later in the turn. */
export function keep(
  kept: KeptAnswers,
  asked: Conversation,
  calls: readonly ModelToolCall[],
  response: readonly SdkMessage[],
) {
  const answer = response.find(
    (message): message is AssistantModelMessage => message.role === "assistant",
  );
  const [first] = calls;
  if (!answer || !first) return;
  const text =
    typeof answer.content === "string"
      ? answer.content
      : answer.content
          .map((part) => (part.type === "text" ? part.text : ""))
          .join("");
  kept.set(first.id, { ...asked, visible: assistantOf(text, calls), answer });
}

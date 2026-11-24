import { z } from "zod";

import type { AiToolAnswer } from "./ai-agents.js";

// A request: what someone says or types to Sanctum, as text. The core opens a
// turn for it and hands it to Sanctum's Assistant, the household's one AI
// assistant, whose `requests` handler answers with `request.reply()`. Only
// that app may declare one: the core refuses it from any other.

/** The app every request goes to. */
export const assistantAppId = "sanctum.assistant";

export const requestLanguages = ["en", "de"] as const;
export type RequestLanguage = (typeof requestLanguages)[number];

/** How long a request, or a reply, is at most. */
export const requestTextMaxLength = 2_000;
export const replyTextMaxLength = 4_000;

/** One of a device's recent exchanges, as the next request sees it. */
export type RequestExchange = {
  /** What was asked. */
  asked: string;
  /** The tools called for it, each with its answer, or null if it never came. */
  calls: { name: string; input: unknown; answer: AiToolAnswer | null }[];
  /** What the Assistant replied, or null when it didn't. */
  reply: string | null;
  /** The next request ended it before it finished. */
  cutOff: boolean;
};

/** What a request carries to the Assistant. */
export type AssistantRequest = {
  text: string;
  language: RequestLanguage;
  /** The room it was asked in, as a default for "the lights", or null. */
  room: string | null;
  /** Where it was asked: a client, such as Kitchen Tablet, or a device. */
  from: { kind: "client" | "device"; name: string };
  /** The same place's recent exchanges, oldest first. */
  earlier: RequestExchange[];
};

/** The Assistant's answer to a request, in words. */
export type RequestReply = { text: string };

/** A request as the handler gets it: its words, and how to answer them. */
export type AssistantRequestCall = AssistantRequest & {
  /** Answers it, once; the household's words go back to whoever asked. */
  reply(reply: RequestReply): Promise<void>;
};

const answerSchema = z.strictObject({ text: z.string(), isError: z.boolean() });

export const assistantRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(requestTextMaxLength),
  language: z.enum(requestLanguages),
  room: z.string().min(1).max(128).nullable(),
  from: z.strictObject({
    kind: z.enum(["client", "device"]),
    name: z.string().min(1).max(128),
  }),
  earlier: z
    .array(
      z.strictObject({
        asked: z.string().max(requestTextMaxLength),
        calls: z.array(
          z.strictObject({
            name: z.string(),
            input: z.unknown(),
            answer: answerSchema.nullable(),
          }),
        ),
        reply: z.string().max(replyTextMaxLength).nullable(),
        cutOff: z.boolean(),
      }),
    )
    .max(6),
}) satisfies z.ZodType<AssistantRequest>;

export const requestReplySchema = z.strictObject({
  text: z.string().trim().min(1).max(replyTextMaxLength),
}) satisfies z.ZodType<RequestReply>;

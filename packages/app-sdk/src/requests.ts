import { z } from "zod";

// A request: what someone types to Sanctum. The core opens a
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

/** What a request carries to the Assistant. */
export type AssistantRequest = {
  text: string;
  language: RequestLanguage;
  /** The name of the client it was typed on, such as Kitchen Tablet. */
  clientName: string;
};

/** The Assistant's answer to a request, in words. */
export type RequestReply = { text: string };

/** A request as the handler gets it: its words, and how to answer them. */
export type AssistantRequestCall = AssistantRequest & {
  /** Answers it, once; the household's words go back to whoever asked. */
  reply(reply: RequestReply): Promise<void>;
};

export const assistantRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(requestTextMaxLength),
  language: z.enum(requestLanguages),
  clientName: z.string().min(1).max(128),
}) satisfies z.ZodType<AssistantRequest>;

export const requestReplySchema = z.strictObject({
  text: z.string().trim().min(1).max(replyTextMaxLength),
}) satisfies z.ZodType<RequestReply>;

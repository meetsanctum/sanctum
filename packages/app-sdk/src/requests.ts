import { z } from "zod";

// A request: what someone types to Sanctum. The core opens a
// turn for it and hands it to Sanctum's Assistant, the household's one AI
// assistant, whose `requests` handler answers with `request.reply()`. Only
// that app may declare one: the core refuses it from any other.
//
// Each device someone asks from is a conversation of its own. A newer
// request from the same device takes over from one still running: the older
// one's signal aborts and its later calls are refused `turn_ended`. The
// newer one gets it in `earlier`, with the device's other exchanges of the
// last 5 minutes, which the core keeps in memory only. The Assistant must
// not store them.

/** The app every request goes to. */
export const assistantAppId = "sanctum.assistant";

export const requestLanguages = ["en", "de"] as const;
export type RequestLanguage = (typeof requestLanguages)[number];

/** How long a request, or a reply, is at most. */
export const requestTextMaxLength = 2_000;
export const replyTextMaxLength = 4_000;

/**
 * A tool the Assistant called in an earlier exchange, with how it ended:
 * its answer, `too_long` for an answer over 4 KB, which is left out, or
 * `unknown` for one still running when a newer request cut the exchange off.
 */
export type EarlierToolCall = {
  name: string;
  input: Record<string, unknown>;
} & (
  | { outcome: "answered"; text: string; isError: boolean }
  | { outcome: "too_long"; isError: boolean }
  | { outcome: "unknown" }
);

/** One of the device's exchanges of the last 5 minutes, oldest first. */
export type EarlierExchange = {
  /** What was asked. */
  asked: string;
  /** When, as an ISO 8601 time. */
  at: string;
  tools: EarlierToolCall[];
  /** The reply the Assistant gave, or null for none. */
  reply: string | null;
  /** Whether a newer request took over while it was still running. */
  cutOff: boolean;
};

/** What a request carries to the Assistant. */
export type AssistantRequest = {
  text: string;
  language: RequestLanguage;
  /** The name of the client it was typed on, such as Kitchen Tablet. */
  clientName: string;
  /** That device's last exchanges, up to 6 and 32 KB, oldest first. */
  earlier: EarlierExchange[];
};

/** The Assistant's answer to a request, in words. */
export type RequestReply = { text: string };

/** A request as the handler gets it: its words, and how to answer them. */
export type AssistantRequestCall = AssistantRequest & {
  /** Answers it, once; the household's words go back to whoever asked. */
  reply(reply: RequestReply): Promise<void>;
  /**
   * Aborts when the request ends before the handler does: a newer request
   * from the same device took over, or the Assistant stopped. The core
   * refuses its later calls `turn_ended`.
   */
  signal: AbortSignal;
};

const toolCallSchema = z.strictObject({
  name: z.string().min(1).max(64),
  input: z.record(z.string(), z.unknown()),
});

export const earlierExchangeSchema = z.strictObject({
  asked: z.string().max(requestTextMaxLength),
  at: z.iso.datetime(),
  tools: z
    .array(
      z.discriminatedUnion("outcome", [
        toolCallSchema.extend({
          outcome: z.literal("answered"),
          text: z.string(),
          isError: z.boolean(),
        }),
        toolCallSchema.extend({
          outcome: z.literal("too_long"),
          isError: z.boolean(),
        }),
        toolCallSchema.extend({ outcome: z.literal("unknown") }),
      ]),
    )
    .max(512),
  reply: z.string().max(replyTextMaxLength).nullable(),
  cutOff: z.boolean(),
}) satisfies z.ZodType<EarlierExchange>;

export const assistantRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(requestTextMaxLength),
  language: z.enum(requestLanguages),
  clientName: z.string().min(1).max(128),
  earlier: z.array(earlierExchangeSchema).max(6),
}) satisfies z.ZodType<AssistantRequest>;

export const requestReplySchema = z.strictObject({
  text: z.string().trim().min(1).max(replyTextMaxLength),
}) satisfies z.ZodType<RequestReply>;

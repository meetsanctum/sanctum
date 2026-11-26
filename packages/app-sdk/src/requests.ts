import { z } from "zod";

// A request: what someone types to Sanctum, or says to a smart speaker. The
// core opens a turn for it and hands it to Sanctum's Assistant, the
// household's one AI assistant, whose `requests` handler answers with
// `request.reply()`. Only that app may declare one: the core refuses it from
// any other. Where speech recognition is available, a spoken request reaches
// it as words and the reply can be played on the speaker.
//
// Each client or smart speaker someone asks from is a conversation of its
// own. A newer request from the same one takes over from one still running:
// the older one's signal aborts and its later calls are refused
// `turn_ended`. The newer one gets it in `earlier`, with the other exchanges
// of the last 5 minutes there, which the core keeps in memory only. The
// Assistant must not store them.

/** The app every request goes to. */
export const assistantAppId = "sanctum.assistant";

export const requestLanguages = ["en", "de"] as const;
export type RequestLanguage = (typeof requestLanguages)[number];

/** How long a request, or a reply, is at most. */
export const requestTextMaxLength = 2_000;
export const replyTextMaxLength = 4_000;

/**
 * A tool the Assistant called in an earlier exchange, with how it ended:
 * its answer, `too_long` for an answer left out to fit the window, or
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

/** One of the exchanges of the last 5 minutes where it was asked, oldest first. */
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

/** Where a request was asked: on a smart speaker or a client, by its name. */
export type RequestFrom<
  Kind extends "speaker" | "client" = "speaker" | "client",
> = {
  kind: Kind;
  /** Such as Office Speaker or Kitchen Tablet. */
  name: string;
};

/** A room of the home, by the core's id and its name. */
export type RequestRoom = { id: string; name: string };

/** A request before the core adds its earlier exchanges. */
export type AssistantRequestInput = {
  text: string;
  language: RequestLanguage;
} & (
  | { from: RequestFrom<"client">; room: null }
  | {
      from: RequestFrom<"speaker">;
      /**
       * The speaker's room in Devices, or null if it is unassigned.
       * A request for "the lights" means this room's unless it names another.
       */
      room: RequestRoom | null;
    }
);

/** What a request carries to the Assistant. */
export type AssistantRequest = AssistantRequestInput & {
  /** The last exchanges where it was asked, up to 6 and 32 KB, oldest first. */
  earlier: EarlierExchange[];
};

/**
 * The Assistant's answer to a request, in words. Words that only confirm an
 * action that worked, such as "Turned off the Office lights", are a
 * `confirmation`: a client shows them, and where spoken replies are available
 * a speaker can play a success chime in their place.
 */
export type RequestReply = { text: string; confirmation?: boolean };

/** A request as the handler gets it: its words, and how to answer them. */
export type AssistantRequestCall = AssistantRequest & {
  /** Answers it, once; the household's words go back to whoever asked. */
  reply(reply: RequestReply): Promise<void>;
  /**
   * Aborts when the request ends before the handler does: a newer request
   * from the same client or speaker took over, the speaker went, the
   * Assistant stopped, or time ran out.
   * The core refuses its later calls `turn_ended`.
   */
  signal: AbortSignal;
};

/** A tool call from the Assistant, in a live request or its history. */
export const aiToolCallSchema = z.strictObject({
  name: z.string().min(1).max(64),
  input: z.record(z.string(), z.unknown()),
});

export const earlierToolLimit = 512;

export const earlierExchangeSchema = z.strictObject({
  asked: z.string().max(requestTextMaxLength),
  at: z.iso.datetime(),
  tools: z
    .array(
      z.discriminatedUnion("outcome", [
        aiToolCallSchema.extend({
          outcome: z.literal("answered"),
          text: z.string(),
          isError: z.boolean(),
        }),
        aiToolCallSchema.extend({
          outcome: z.literal("too_long"),
          isError: z.boolean(),
        }),
        aiToolCallSchema.extend({ outcome: z.literal("unknown") }),
      ]),
    )
    .max(earlierToolLimit),
  reply: z.string().max(replyTextMaxLength).nullable(),
  cutOff: z.boolean(),
}) satisfies z.ZodType<EarlierExchange>;

const nameSchema = z.string().min(1).max(128);

export const assistantPromptSchema = z.strictObject({
  text: z.string().trim().min(1).max(requestTextMaxLength),
  language: z.enum(requestLanguages),
});

const requestWordsSchema = assistantPromptSchema.extend({
  earlier: z.array(earlierExchangeSchema).max(6),
});

export const assistantRequestSchema = z.union([
  requestWordsSchema.extend({
    room: z.null(),
    from: z.strictObject({ kind: z.literal("client"), name: nameSchema }),
  }),
  requestWordsSchema.extend({
    room: z.strictObject({ id: nameSchema, name: nameSchema }).nullable(),
    from: z.strictObject({ kind: z.literal("speaker"), name: nameSchema }),
  }),
]) satisfies z.ZodType<AssistantRequest>;

/** A request as a runner before protocol 26 takes it, by the client's name. */
export type EarlierAssistantRequest = Omit<
  AssistantRequest,
  "room" | "from" | "earlier"
> & { clientName: string; earlier?: EarlierExchange[] };

export const requestReplySchema = z.strictObject({
  text: z.string().trim().min(1).max(replyTextMaxLength),
  confirmation: z.boolean().optional(),
}) satisfies z.ZodType<RequestReply>;

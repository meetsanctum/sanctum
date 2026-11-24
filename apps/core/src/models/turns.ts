import {
  ActionError,
  turnLimits,
  type Actor,
  type ModelAnswerPiece,
  type ModelSourceShown,
  type ModelStop,
} from "@meetsanctum/app-sdk";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import type { ActivityAuthor, NewActivityEntry } from "../activity/activity.js";
import type { Watched } from "../app-host/net.js";
import { ask, ModelError } from "./client.js";
import type { KeptAnswers } from "./conversation.js";
import type { Models, SourceInUse } from "./models.js";

// A turn: one call from someone waiting, a person or a shared device, to an
// app's action that declares one, within which the app may ask the home's
// AI model. It ends with the call, and answers still under way stop with it.
// Each answer is kept by a handle while it comes, and the app reads its
// pieces after the last it read, so a long answer is many short reads.
//
// The caps keep a false start or a loop from holding the model: the first
// piece within 90 s in the home or 30 s with a provider, 4,096 tokens an
// answer, 8 answers a turn, and the turn's own time. Nothing said is kept:
// the activity log has one entry a turn, with its tokens and time.

/** How long a read waits for a piece, when there's none yet. */
const readWaitMs = 2_000;
/** The byte limit for one read's JSON array of pieces. */
const readBytes = 64 * 1024;
// A JSON string can take six bytes per UTF-16 code unit. Reserve room for
// the piece, array brackets and one extra code unit to keep a pair whole.
const textUnits = Math.floor(readBytes / 6) - 8;

const toolName = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const content = z.string().max(200_000);

const question = z.object({
  messages: z
    .array(
      z.discriminatedUnion("role", [
        z.object({ role: z.enum(["system", "user"]), content }),
        z.object({
          role: z.literal("assistant"),
          content,
          toolCalls: z
            .array(
              z.object({
                id: z.string().min(1).max(128),
                name: toolName,
                input: z.unknown(),
              }),
            )
            .max(32)
            .optional(),
        }),
        z.object({
          role: z.literal("tool"),
          toolCallId: z.string().min(1).max(128),
          content,
        }),
      ]),
    )
    .min(1)
    .max(256),
  tools: z
    .array(
      z.object({
        name: toolName,
        description: z.string().max(2_048),
        input: z.record(z.string(), z.unknown()),
      }),
    )
    .max(64)
    .refine(
      (tools) => new Set(tools.map((tool) => tool.name)).size === tools.length,
      "each tool has a name of its own",
    )
    .optional(),
  maxTokens: z.int().min(1).max(turnLimits.maxTokens).optional(),
});

type Answer = {
  pieces: ModelAnswerPiece[];
  ended: boolean;
  sourceId: string | undefined;
  controller: AbortController;
  waiting: Set<() => void>;
};

/** One turn's calls into the home's AI model, for one app. */
export type Turn = {
  /** Starts an answer and gives its handle. */
  open(question: unknown, watch: () => Watched): string;
  /** The answer's pieces after the first `after`, waiting a moment for one. */
  read(handle: unknown, after: unknown): Promise<ModelAnswerPiece[]>;
  cancel(handle: string): void;
  /** Ends the turn with its call: what's under way stops. */
  end(): void;
};

/** Whether a call to an action opens a turn: a person's or a shared device's. */
export function opensTurn(action: { turn: boolean }, actor: Actor) {
  return action.turn && (actor.kind === "user" || actor.kind === "client");
}

export function createTurns(options: {
  models: Pick<Models, "inUse" | "count" | "onLeaving">;
  record: (entry: NewActivityEntry) => string;
  log: (message: string) => void;
}) {
  const { models } = options;
  // The answers under way in every turn, to stop those of a source that
  // leaves.
  const underWay = new Set<Answer>();
  // Once the core is stopping, no answer starts.
  let closed = false;

  models.onLeaving((sourceId) => {
    for (const answer of underWay) {
      if (answer.sourceId === sourceId) stop(answer, "unavailable");
    }
  });

  function push(answer: Answer, piece: ModelAnswerPiece) {
    if (answer.ended) return;
    answer.pieces.push(piece);
    if (piece.type === "end") {
      answer.ended = true;
      underWay.delete(answer);
    }
    for (const wake of answer.waiting) wake();
  }

  function stop(answer: Answer, as: ModelStop) {
    if (answer.ended) return;
    answer.controller.abort();
    // Ended now, whatever the source does after.
    push(answer, { type: "end", stop: as, tokens: { read: 0, written: 0 } });
  }

  // Asks the source, and keeps what it answers as pieces.
  async function run(
    answer: Answer,
    source: SourceInUse,
    asked: z.infer<typeof question>,
    appId: string,
    counted: (tokens: number) => void,
    watched: Watched,
    keptBySource: Map<string, KeptAnswers>,
  ) {
    const revoked = () => stop(answer, "cancelled");
    watched.signal.addEventListener("abort", revoked, { once: true });
    try {
      const endpoint = source.endpoint();
      // Kept by source, model and key, so an answer goes back only to
      // where it came from.
      const keyHash = createHash("sha256")
        .update(endpoint.key ?? "")
        .digest("hex");
      const connection = `${source.id} ${source.model} ${keyHash}`;
      let kept = keptBySource.get(connection);
      if (!kept) {
        kept = new Map();
        keptBySource.set(connection, kept);
      }
      const pieces = ask(
        endpoint,
        {
          model: source.model,
          messages: asked.messages,
          // In the same order every time, so a source reuses the start of
          // the prompt.
          tools: [...(asked.tools ?? [])].sort((a, b) =>
            a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
          ),
          maxTokens: asked.maxTokens ?? turnLimits.maxTokens,
        },
        {
          signal: answer.controller.signal,
          firstPieceMs: source.shown.inHome
            ? turnLimits.firstPieceInHomeMs
            : turnLimits.firstPieceWithProviderMs,
          kept,
        },
      );
      let hasPiece = false;
      for await (const piece of pieces) {
        if (answer.ended) break;
        if (piece.type === "end") {
          models.count(source.id, appId, piece.tokens);
          counted(piece.tokens.read + piece.tokens.written);
          push(answer, {
            ...piece,
            stop:
              hasPiece || piece.stop === "limit" ? piece.stop : "unavailable",
          });
        } else if (Buffer.byteLength(JSON.stringify(piece)) + 2 <= readBytes) {
          hasPiece = true;
          push(answer, piece);
        } else if (piece.type === "text") {
          hasPiece = true;
          let start = 0;
          while (start < piece.text.length) {
            let end = start + textUnits;
            // Don't split a Unicode code point across pieces.
            const next = piece.text.charCodeAt(end);
            if (next >= 0xdc00 && next <= 0xdfff) end += 1;
            push(answer, { type: "text", text: piece.text.slice(start, end) });
            start = end;
          }
        } else {
          // A tool call is delivered whole, so it must fit in one read.
          stop(answer, "unavailable");
          break;
        }
      }
    } catch (error) {
      if (!answer.ended && !(error instanceof ModelError)) {
        options.log(
          `models: an answer for ${appId} failed (${error instanceof Error ? error.message : String(error)})`,
        );
      }
    } finally {
      watched.signal.removeEventListener("abort", revoked);
      watched.done();
      stop(answer, "unavailable");
    }
  }

  return {
    /** A step of stopping: answers under way end, and none starts. */
    close() {
      closed = true;
      for (const answer of underWay) stop(answer, "unavailable");
    },

    /** The source in use as apps see it, or null. */
    source(): ModelSourceShown | null {
      return models.inUse()?.shown ?? null;
    },

    /** Opens a turn for one call to an app's action. */
    open(turn: { appId: string; appName: string; who: ActivityAuthor }): Turn {
      const answers = new Map<string, Answer>();
      const startedAt = Date.now();
      let tokens = 0;
      const used: Pick<SourceInUse, "id" | "model" | "detail">[] = [];
      // Claude's tool answers are kept only for this turn, scoped to the
      // source, model and key that produced them.
      const keptBySource = new Map<string, KeptAnswers>();
      let ended = false;

      function answerOf(handle: unknown) {
        const answer =
          typeof handle === "string" ? answers.get(handle) : undefined;
        if (!answer)
          throw new Error(`${turn.appId} has no answer ${String(handle)}`);
        return answer;
      }

      return {
        open(input, watch) {
          if (ended) throw new Error(`This turn of ${turn.appId} has ended`);
          if (answers.size >= turnLimits.answers) {
            throw new ActionError("limited");
          }
          const asked = question.safeParse(input);
          if (!asked.success) {
            throw new Error(
              `${turn.appId} asked the AI model something it can't take: ${z.prettifyError(asked.error)}`,
            );
          }
          const handle = randomUUID();
          const source = models.inUse();
          const answer: Answer = {
            pieces: [],
            ended: false,
            sourceId: source?.id,
            controller: new AbortController(),
            waiting: new Set(),
          };
          answers.set(handle, answer);
          if (!source || closed) {
            stop(answer, "unavailable");
            return handle;
          }
          const { id, model, detail } = source;
          if (!used.some((asked) => asked.id === id && asked.model === model)) {
            used.push({ id, model, detail });
          }
          underWay.add(answer);
          void run(
            answer,
            source,
            asked.data,
            turn.appId,
            (more) => {
              tokens += more;
            },
            watch(),
            keptBySource,
          );
          return handle;
        },

        async read(handle, after) {
          const answer = answerOf(handle);
          if (
            typeof after !== "number" ||
            !Number.isInteger(after) ||
            after < 0 ||
            after > answer.pieces.length
          ) {
            throw new Error(`${turn.appId} read past its answer`);
          }
          if (after === answer.pieces.length && !answer.ended) {
            await new Promise<void>((done) => {
              const wake = () => {
                clearTimeout(timer);
                answer.waiting.delete(wake);
                done();
              };
              const timer = setTimeout(wake, readWaitMs);
              answer.waiting.add(wake);
            });
          }
          const read: ModelAnswerPiece[] = [];
          let size = 2;
          for (let index = after; index < answer.pieces.length; index += 1) {
            const piece = answer.pieces[index]!;
            size +=
              Buffer.byteLength(JSON.stringify(piece)) +
              (index === after ? 0 : 1);
            if (size > readBytes) break;
            read.push(piece);
          }
          return read;
        },

        cancel(handle) {
          stop(answerOf(handle), "cancelled");
        },

        end() {
          if (ended) return;
          ended = true;
          for (const answer of answers.values()) stop(answer, "cancelled");
          keptBySource.clear();
          if (answers.size === 0) return;
          const answered = [...answers.values()].some((answer) => {
            const last = answer.pieces.at(-1);
            return last?.type === "end" && last.stop !== "unavailable";
          });
          const answerCount = answers.size;
          answers.clear();
          const only = used.length === 1 ? used[0] : undefined;
          options.record({
            action: "models.turn",
            outcome: answered ? "ok" : "failed",
            ...(answered ? {} : { reason: "unavailable" }),
            ...turn.who,
            ...(only ? { subjectId: only.id } : {}),
            detail: {
              app: turn.appId,
              appName: turn.appName,
              ...(used.length > 1
                ? { models: used.map(({ detail }) => detail) }
                : only?.detail),
              answers: answerCount,
              tokens,
              ms: Date.now() - startedAt,
            },
          });
        },
      };
    },
  };
}

export type Turns = ReturnType<typeof createTurns>;

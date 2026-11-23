// The home's AI models, as Settings shows and changes them: the sources the
// household added, one of them in use, each with how its last check went and
// the tokens it used. A source is Ollama on a computer in the home, reached
// at a private address, or a provider reached with an API key; the core
// keeps the key and never hands it back.
//
// Apps that hold `models.use` ask the source in use through the core, with
// ctx.models, and only within a turn: a call from a person or a shared
// device to an action that declares `turn: true`. Answers stream by handle.

/** The providers a source can be, with Ollama on a computer in the home. */
export const modelProviders = ["openrouter", "openai"] as const;
export type ModelProvider = (typeof modelProviders)[number];
export type ModelSourceKind = "computer" | ModelProvider;

/** Ollama's port when nobody changed it. */
export const ollamaPort = 11434;

/** One model a source offers, as its list names it. */
export type ModelChoice = {
  id: string;
  name: string;
  /** Its download, in bytes, where the source says. */
  size?: number;
};

/** How a source's last check went. */
export type ModelCheck = {
  at: string;
  /**
   * `answered`: it answered and called the tool; `noTool`: it answered
   * without calling it; `failed`: no answer, with the problem.
   */
  outcome: "answered" | "noTool" | "failed";
  /** From asking to the first piece of the answer. */
  firstWordMs?: number;
  problem?: ModelProblem;
};

/** Why a source gave no answer, in words Settings turns into a sentence. */
export type ModelProblem =
  "unreachable" | "timeout" | "key" | "model" | "refused" | "answer";

export type ModelSourceInfo = {
  id: string;
  kind: ModelSourceKind;
  /** The model, by the source's id for it, such as qwen3:8b. */
  model: string;
  /** The model as people read it, such as Qwen3 8B. */
  modelName: string;
  /** A computer's name, such as Office Mac. */
  computer?: string;
  /** A computer's address, such as 192.168.1.40:11434. */
  address?: string;
  /** The end of a provider's key, such as 4f2a. */
  keyEnd?: string;
  inUse: boolean;
  check?: ModelCheck;
  /** While a check runs. */
  checking?: boolean;
  /** While the source in use doesn't answer, since when. */
  downSince?: string;
  /** Tokens read and written, today and the last 30 days with today. */
  tokens: { today: number; month: number };
};

/** An app that may use the home's AI model, with the tokens its answers took. */
export type ModelAppInfo = {
  id: string;
  name: string;
  tokens: { today: number; month: number };
};

export type ModelsInfo = { sources: ModelSourceInfo[]; apps: ModelAppInfo[] };

/** Looking at a source before adding it: a computer's address, or a key. */
export type LookAtModelSource =
  { kind: "computer"; address: string } | { kind: ModelProvider; key: string };

export type ModelSourceLook =
  | { found: true; address?: string; models: ModelChoice[] }
  | { found: false; problem: ModelProblem; address?: string };

export type AddModelSource =
  | { kind: "computer"; address: string; computer: string; model: string }
  | { kind: ModelProvider; key: string; model: string };

export type ChangeModelSource = {
  computer?: string;
  key?: string;
  model?: string;
};

/** What lets an app ask the home's AI model, within a turn. */
export const modelsUsePermission = "models.use";

/**
 * The caps on a turn: the time to an answer's first piece, in the home and
 * with a provider; the whole turn, which is its action's time too; the tokens
 * one answer may write; and how many answers a turn may ask for.
 */
export const turnLimits = {
  firstPieceInHomeMs: 90_000,
  firstPieceWithProviderMs: 30_000,
  turnMs: 180_000,
  maxTokens: 4_096,
  answers: 8,
} as const;

/** A call the model made to one of the tools it was given. */
export type ModelToolCall = { id: string; name: string; input: unknown };

/** One message of what the model is given, in order. */
export type ModelMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ModelToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

/** A tool the model may call: its name, what it does, and its input's JSON Schema. */
export type ModelTool = {
  name: string;
  description: string;
  input: Record<string, unknown>;
};

/** The tokens an answer read and wrote. */
export type ModelTokens = { read: number; written: number };

/**
 * Why an answer stopped: it was done, it called tools, it reached its
 * tokens, someone cancelled it or its turn ended, or the source gave none
 * (none in use, not answering, too slow to start, or removed meanwhile).
 */
export type ModelStop = "done" | "tool" | "limit" | "cancelled" | "unavailable";

/** A piece of an answer: text as it comes, each tool call whole, then one end. */
export type ModelAnswerPiece =
  | { type: "text"; text: string }
  | ({ type: "tool" } & ModelToolCall)
  | { type: "end"; stop: ModelStop; tokens: ModelTokens };

/** What an app asks the model. */
export type ModelQuestion = {
  messages: ModelMessage[];
  tools?: ModelTool[];
  /** At most `turnLimits.maxTokens`, which it is when left out. */
  maxTokens?: number;
};

/** The source in use as apps see it, never its address or key. */
export type ModelSourceShown = {
  /** A computer's name, or the provider's, such as Office Mac or OpenRouter. */
  name: string;
  /** The model, such as Qwen3 8B. */
  model: string;
  /** Whether it runs on a computer in the home. */
  inHome: boolean;
};

/** An answer under way: its pieces as they come. */
export interface ModelAnswer extends AsyncIterable<ModelAnswerPiece> {
  /** Waits for the whole answer and gives its text. */
  text(): Promise<string>;
  /** Stops the answer; its end says `cancelled`. */
  cancel(): Promise<void>;
}

// The home's AI models, as Settings shows and changes them: the sources the
// household added, one of them in use, each with how its last check went and
// the tokens it used. A source is Ollama on a computer in the home, reached
// at a private address, or a provider reached with an API key; the core
// keeps the key and never hands it back.

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

export type ModelsInfo = { sources: ModelSourceInfo[] };

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

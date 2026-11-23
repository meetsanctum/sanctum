import type {
  ModelProblem,
  ModelProvider,
  ModelSourceInfo,
} from "@meetsanctum/app-sdk";

import { productName } from "../brand";

// The words Settings uses for the home's AI models: each source by its
// model and where it runs, how its last check went, and what to do when it
// doesn't answer.

export const modelsTitle = "AI Models";

export const providerNames: Record<ModelProvider, string> = {
  openrouter: "OpenRouter",
  openai: "OpenAI",
};

/** A source as people read it, such as "Qwen3 8B on Office Mac". */
export function sourceName(source: ModelSourceInfo) {
  switch (source.kind) {
    case "sanctum":
      return `${source.modelName} on ${productName}`;
    case "computer":
      return `${source.modelName} on ${source.computer ?? source.address}`;
    default:
      return `${source.modelName} with ${providerNames[source.kind]}`;
  }
}

/** What runs it or reaches it, under its name: its name says where. */
export function sourceDetail(source: ModelSourceInfo) {
  switch (source.kind) {
    case "sanctum":
      return "Ollama";
    case "computer":
      return `Ollama at ${source.address}`;
    default:
      return `Key ending in ${source.keyEnd}`;
  }
}

const minute = 60_000;

function agoText(at: string, now: Date) {
  const ago = now.getTime() - new Date(at).getTime();
  if (ago < 2 * minute) return "just now";
  if (ago < 60 * minute) return `${Math.floor(ago / minute)} minutes ago`;
  const hours = Math.floor(ago / (60 * minute));
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  return `on ${new Date(at).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  })}`;
}

const timeText = (at: string) =>
  new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });

/** Why a source gave no answer, and what to do about it. */
export function problemText(
  problem: ModelProblem,
  where: { kind: ModelSourceInfo["kind"]; address?: string },
) {
  const provider =
    where.kind === "computer" || where.kind === "sanctum"
      ? ""
      : providerNames[where.kind];
  if (where.kind === "sanctum") {
    switch (problem) {
      case "unreachable":
        return "Ollama isn't answering. Check that the Ollama app is running.";
      case "timeout":
        return `It took too long to answer. A model that's large for ${productName} can be slow at first: check again in a minute.`;
      case "model":
        return "That model isn't on Ollama any more. Choose another.";
      default:
        return `Its answer didn't make sense to ${productName}.`;
    }
  }
  switch (problem) {
    case "unreachable":
      return where.kind === "computer"
        ? `Nothing answered at ${where.address ?? "that address"}. Check that Ollama is running there and listens on your network: on that computer, set OLLAMA_HOST to 0.0.0.0 and start Ollama again.`
        : `${provider} didn't answer. Check your home's connection to the internet.`;
    case "timeout":
      return where.kind === "computer"
        ? "It took too long to answer. A model that's large for that computer can be slow at first: check again in a minute."
        : `${provider} took too long to answer.`;
    case "key":
      return `${provider || "The source"} didn't take that key. Check it in your account there.`;
    case "model":
      return "That model isn't there any more. Choose another.";
    case "refused":
      return where.kind === "computer"
        ? "That isn't an address on your home's network, such as 192.168.1.40."
        : `${provider} refused the question.`;
    case "answer":
      return `Its answer didn't make sense to ${productName}.`;
  }
}

export type CheckLine = { text: string; tone: "good" | "problem" | "plain" };

/** How a source's last check went, or what's happening now. */
export function checkLine(
  source: ModelSourceInfo,
  now = new Date(),
): CheckLine | undefined {
  if (source.checking) {
    return { text: "Checking: asking it a short question", tone: "plain" };
  }
  const check = source.check;
  if (
    source.downSince &&
    (check?.outcome !== "failed" || check.problem === "unreachable")
  ) {
    const where =
      source.kind === "sanctum"
        ? "Check that the Ollama app is running."
        : source.kind === "computer"
          ? `Check that ${source.computer ?? "the computer"} is awake and Ollama is running there.`
          : "Check your home's connection to the internet.";
    return {
      text: `Not answering since ${timeText(source.downSince)}. ${where}`,
      tone: "problem",
    };
  }
  if (!check) return undefined;
  const checked = `checked ${agoText(check.at, now)}`;
  switch (check.outcome) {
    case "answered":
      return {
        text: `Answered in ${((check.firstWordMs ?? 0) / 1000).toFixed(1)} s and used the tool · ${checked}`,
        tone: "good",
      };
    case "noTool":
      return {
        text: "Answered, but may not use your home's AI tools well or act on your devices",
        tone: "plain",
      };
    case "failed":
      return {
        text:
          check.problem === "refused" && source.kind === "computer"
            ? "Ollama refused the check. The model may not support tools."
            : problemText(check.problem ?? "answer", source),
        tone: "problem",
      };
  }
}

/** A model's download, such as 5.2 GB. */
export function sizeText(bytes: number) {
  return bytes >= 1e9
    ? `${(bytes / 1e9).toFixed(1)} GB`
    : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

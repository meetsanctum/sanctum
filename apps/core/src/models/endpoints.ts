import type { ModelChoice, ModelProvider } from "@meetsanctum/app-sdk";
import { z } from "zod";

import { addressText, isHomeAddress, type HomeAddress } from "./addresses.js";
import {
  ModelError,
  problemOfError,
  problemOfStatus,
  type ModelApi,
  type ModelEndpoint,
} from "./client.js";

// Where each kind of source answers. Ollama on Sanctum is reached at the
// address the manager gives for its service, never one typed in; a
// computer's Ollama over HTTP at the address it was added with, on the
// home's network only; a provider only at its own fixed address, over HTTPS
// on the public internet. None follows a redirect.

/** The two ways out: to the home's network, and to the public internet. */
export type ModelFetchers = {
  home: typeof fetch;
  internet: typeof fetch;
};

// Each provider's fixed address, and the SDK's provider that speaks to it.
const providers = {
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", api: "compatible" },
  anthropic: { baseUrl: "https://api.anthropic.com/v1", api: "anthropic" },
  openai: { baseUrl: "https://api.openai.com/v1", api: "openai" },
} as const satisfies Record<ModelProvider, { baseUrl: string; api: ModelApi }>;

/**
 * What a source is reached by: the manager's address for Ollama on
 * Sanctum, a computer's address, or a provider's key.
 */
export type SourceReach =
  | { kind: "sanctum"; url: string }
  | { kind: "computer"; address: HomeAddress }
  | { kind: ModelProvider; key: string };

export function endpointOf(
  reach: SourceReach,
  fetchers: ModelFetchers,
): ModelEndpoint {
  if (reach.kind === "sanctum") {
    return {
      api: "compatible",
      baseUrl: `${reach.url}/v1`,
      fetch: fetchers.home,
    };
  }
  if (reach.kind === "computer") {
    // Checked again each time: the address was the household's to type.
    if (!isHomeAddress(reach.address.host)) {
      throw new ModelError("refused", "not an address in the home");
    }
    return {
      api: "compatible",
      baseUrl: `http://${addressText(reach.address)}/v1`,
      fetch: fetchers.home,
    };
  }
  return {
    ...providers[reach.kind],
    key: reach.key,
    fetch: fetchers.internet,
  };
}

const listTimeoutMs = 10_000;

async function getJson(
  fetcher: typeof fetch,
  url: string,
  key: string | undefined,
  signal?: AbortSignal,
  headers: Record<string, string> = key
    ? { authorization: `Bearer ${key}` }
    : {},
) {
  const timeout = AbortSignal.timeout(listTimeoutMs);
  const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetcher(url, {
      headers,
      redirect: "error",
      signal: both,
    });
  } catch (error) {
    throw problemOfError(error, both);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const problem = problemOfStatus(response.status);
    throw new ModelError(!key || problem === "model" ? "answer" : problem);
  }
  try {
    return (await response.json()) as unknown;
  } catch (error) {
    if (both.aborted) throw problemOfError(error, both);
    throw new ModelError("answer", "the list isn't JSON");
  }
}

const ollamaTags = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      size: z.number().optional(),
      remote_host: z.string().optional(),
      remote_model: z.string().optional(),
    }),
  ),
});
const openAiModels = z.object({
  data: z.array(z.object({ id: z.string(), name: z.string().optional() })),
});
const anthropicModels = z.object({
  data: z.array(
    z.object({ id: z.string().min(1), display_name: z.string().optional() }),
  ),
});

/**
 * How an Ollama tag reads, such as qwen3:8b as Qwen3 8B, llama3.2:3b as
 * Llama3.2 3B and gemma3:latest as Gemma3.
 */
export function ollamaModelName(tag: string): string {
  const [name = tag, variant] = tag.split(":");
  const named = name.charAt(0).toUpperCase() + name.slice(1);
  if (!variant || variant === "latest") return named;
  return /^\d+(\.\d+)?[bkm]$/i.test(variant)
    ? `${named} ${variant.toUpperCase()}`
    : `${named} ${variant}`;
}

// OpenAI's list holds every model of the account's, speech and images
// among them; only those that chat and call tools are offered.
const openAiChat = (id: string) =>
  /^(gpt-|o\d|chatgpt-)/.test(id) &&
  !/(audio|realtime|transcribe|tts|image|search|embedding|instruct)/.test(id);

// Ollama's own models, leaving out its cloud models, which would not run in
// the home.
async function ollamaModels(
  fetcher: typeof fetch,
  baseUrl: string,
  signal?: AbortSignal,
): Promise<ModelChoice[]> {
  const found = ollamaTags.safeParse(
    await getJson(fetcher, `${baseUrl}/api/tags`, undefined, signal),
  );
  if (!found.success) throw new ModelError("answer", "not Ollama's list");
  return found.data.models
    .filter(
      (model) =>
        !model.remote_host &&
        !model.remote_model &&
        !model.name.endsWith("-cloud"),
    )
    .map((model) => ({
      id: model.name,
      name: ollamaModelName(model.name),
      ...(model.size === undefined ? {} : { size: model.size }),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Has Ollama load a model and keep it loaded, so the first question after
 * a restart doesn't wait for it.
 */
export async function warmOllama(
  fetcher: typeof fetch,
  baseUrl: string,
  model: string,
  signal: AbortSignal,
) {
  const response = await fetcher(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model, keep_alive: -1 }),
    redirect: "error",
    signal,
  });
  await response.body?.cancel().catch(() => {});
  if (!response.ok) throw new ModelError(problemOfStatus(response.status));
}

/** The models a source offers, for the household to choose from. */
export async function listModels(
  reach: SourceReach,
  fetchers: ModelFetchers,
  signal?: AbortSignal,
): Promise<ModelChoice[]> {
  switch (reach.kind) {
    case "sanctum":
      return ollamaModels(fetchers.home, reach.url, signal);
    case "computer": {
      if (!isHomeAddress(reach.address.host)) {
        throw new ModelError("refused", "not an address in the home");
      }
      return ollamaModels(
        fetchers.home,
        `http://${addressText(reach.address)}`,
        signal,
      );
    }
    case "openrouter": {
      // The key is checked on its own, since the list of models is public.
      await getJson(
        fetchers.internet,
        `${providers.openrouter.baseUrl}/key`,
        reach.key,
        signal,
      );
      const found = openAiModels.safeParse(
        await getJson(
          fetchers.internet,
          `${providers.openrouter.baseUrl}/models?supported_parameters=tools`,
          reach.key,
          signal,
        ),
      );
      if (!found.success) throw new ModelError("answer", "not a model list");
      return found.data.data
        .map((model) => ({ id: model.id, name: model.name ?? model.id }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    case "anthropic": {
      // Anthropic's own headers; a key's models fit in one page of 1,000.
      const found = anthropicModels.safeParse(
        await getJson(
          fetchers.internet,
          `${providers.anthropic.baseUrl}/models?limit=1000`,
          reach.key,
          signal,
          { "x-api-key": reach.key, "anthropic-version": "2023-06-01" },
        ),
      );
      if (!found.success) throw new ModelError("answer", "not a model list");
      return found.data.data
        .map((model) => ({
          id: model.id,
          name: model.display_name || model.id,
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
    case "openai": {
      const found = openAiModels.safeParse(
        await getJson(
          fetchers.internet,
          `${providers.openai.baseUrl}/models`,
          reach.key,
          signal,
        ),
      );
      if (!found.success) throw new ModelError("answer", "not a model list");
      return found.data.data
        .filter((model) => openAiChat(model.id))
        .map((model) => ({ id: model.id, name: model.id }))
        .sort((a, b) => a.name.localeCompare(b.name));
    }
  }
}

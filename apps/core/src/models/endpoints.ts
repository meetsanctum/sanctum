import type { ModelChoice, ModelProvider } from "@meetsanctum/app-sdk";
import { z } from "zod";

import { addressText, isHomeAddress, type HomeAddress } from "./addresses.js";
import {
  ModelError,
  problemOfError,
  problemOfStatus,
  type ModelEndpoint,
} from "./client.js";

// Where each kind of source answers. A computer's Ollama is reached over
// HTTP at the address it was added with, on the home's network only; a
// provider only at its own fixed address, over HTTPS on the public internet.
// Neither follows a redirect.

/** The two ways out: to the home's network, and to the public internet. */
export type ModelFetchers = {
  home: typeof fetch;
  internet: typeof fetch;
};

const providers = {
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    maxTokensField: "max_tokens",
  },
  openai: {
    baseUrl: "https://api.openai.com/v1",
    maxTokensField: "max_completion_tokens",
  },
} as const satisfies Record<
  ModelProvider,
  {
    baseUrl: string;
    maxTokensField: ModelEndpoint["maxTokensField"];
  }
>;

/** What a source is reached by: a computer's address, or a provider's key. */
export type SourceReach =
  | { kind: "computer"; address: HomeAddress }
  | { kind: ModelProvider; key: string };

export function endpointOf(
  reach: SourceReach,
  fetchers: ModelFetchers,
): ModelEndpoint {
  if (reach.kind === "computer") {
    // Checked again each time: the address was the household's to type.
    if (!isHomeAddress(reach.address.host)) {
      throw new ModelError("refused", "not an address in the home");
    }
    return {
      baseUrl: `http://${addressText(reach.address)}/v1`,
      fetch: fetchers.home,
      maxTokensField: "max_tokens",
    };
  }
  const provider = providers[reach.kind];
  return {
    baseUrl: provider.baseUrl,
    key: reach.key,
    fetch: fetchers.internet,
    maxTokensField: provider.maxTokensField,
  };
}

const listTimeoutMs = 10_000;

async function getJson(
  fetcher: typeof fetch,
  url: string,
  key: string | undefined,
  signal?: AbortSignal,
) {
  const timeout = AbortSignal.timeout(listTimeoutMs);
  const both = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: key ? { authorization: `Bearer ${key}` } : {},
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

/** The models a source offers, for the household to choose from. */
export async function listModels(
  reach: SourceReach,
  fetchers: ModelFetchers,
  signal?: AbortSignal,
): Promise<ModelChoice[]> {
  switch (reach.kind) {
    case "computer": {
      if (!isHomeAddress(reach.address.host)) {
        throw new ModelError("refused", "not an address in the home");
      }
      const found = ollamaTags.safeParse(
        await getJson(
          fetchers.home,
          `http://${addressText(reach.address)}/api/tags`,
          undefined,
          signal,
        ),
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

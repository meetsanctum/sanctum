import type { HostResources } from "@meetsanctum/app-sdk";

// The models the page offers, and whether this Sanctum can run them. Each is
// one that calls tools well, which a home's AI model needs, with its
// download and the memory it takes with a short conversation, as Ollama runs
// it on the processor. The page offers only those that fit the memory and
// storage there is, and says when the processor is likely too slow.

const gb = 1_000_000_000;

export type OfferedModel = {
  /** Ollama's tag, such as qwen3:4b. */
  id: string;
  name: string;
  sizeBytes: number;
  memoryBytes: number;
  /** What sets it apart, where something does. */
  note?: string;
};

export const offeredModels: readonly OfferedModel[] = [
  {
    id: "qwen3:1.7b",
    name: "Qwen3 1.7B",
    sizeBytes: 1.4 * gb,
    memoryBytes: 2 * gb,
  },
  {
    id: "llama3.2:3b",
    name: "Llama 3.2 3B",
    sizeBytes: 2 * gb,
    memoryBytes: 2.8 * gb,
  },
  {
    id: "qwen3:4b",
    name: "Qwen3 4B",
    sizeBytes: 2.5 * gb,
    memoryBytes: 3.2 * gb,
  },
  {
    id: "qwen3:8b",
    name: "Qwen3 8B",
    sizeBytes: 5.2 * gb,
    memoryBytes: 6.5 * gb,
    note: "better answers, slower",
  },
];

/** Storage left free beside a download, for the home's own data and updates. */
export const storageMarginBytes = 2 * gb;

export type HostCheck = {
  processor: { name: string | null; cores: number; isLikelySlow: boolean };
  /** What a model may take: what's free now, within Ollama's share. */
  memory: { totalBytes: number; roomBytes: number } | null;
  storage: { freeBytes: number } | null;
};

/**
 * What this Sanctum can give Ollama. A processor is likely too slow with
 * fewer than four cores, or without the vector instructions models run
 * quickly on; one that doesn't say is given the benefit of the doubt.
 */
export function hostCheck(
  resources: HostResources,
  ollamaMemoryBytes: number | undefined,
): HostCheck {
  const { processor, memory, storage } = resources;
  return {
    processor: {
      name: processor.name,
      cores: processor.cores,
      isLikelySlow:
        processor.cores < 4 || processor.matrixInstructions === false,
    },
    memory: memory && {
      totalBytes: memory.totalBytes,
      roomBytes: Math.min(
        memory.availableBytes,
        ollamaMemoryBytes ?? memory.availableBytes,
      ),
    },
    storage,
  };
}

/** Whether a model fits the memory and storage this Sanctum has free. */
export function fits(model: OfferedModel, check: HostCheck) {
  return (
    (!check.memory || model.memoryBytes <= check.memory.roomBytes) &&
    (!check.storage ||
      model.sizeBytes + storageMarginBytes <= check.storage.freeBytes)
  );
}

/**
 * The model to suggest: the largest Qwen3 that takes at most a quarter of
 * the host's memory, so the rest of the home keeps its room, such as Qwen3
 * 1.7B with 8 GB and Qwen3 4B with 16 GB.
 */
export function suggestedModel(check: HostCheck) {
  const total = check.memory?.totalBytes;
  if (total === undefined) return undefined;
  return offeredModels
    .filter(
      (model) =>
        model.id.startsWith("qwen3:") &&
        model.memoryBytes <= total / 4 &&
        fits(model, check),
    )
    .at(-1)?.id;
}

/** How a tag reads, where the page doesn't offer it: qwen3:14b as Qwen3 14B. */
export function modelName(tag: string) {
  const offered = offeredModels.find((model) => model.id === tag);
  if (offered) return offered.name;
  const [name = tag, variant] = tag.split(":");
  const named = name.charAt(0).toUpperCase() + name.slice(1);
  if (!variant || variant === "latest") return named;
  return /^\d+(\.\d+)?[bkm]$/i.test(variant)
    ? `${named} ${variant.toUpperCase()}`
    : `${named} ${variant}`;
}

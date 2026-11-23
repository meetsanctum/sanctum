import type { HostResources } from "@meetsanctum/app-sdk";

// The models the page offers, and whether this Sanctum can run them. Each is
// one that calls tools well, which a home's AI model needs, with its
// download and the memory it takes with a short conversation, as Ollama runs
// it on the processor. The page shows what each takes of the memory and
// storage free, offers only those that fit, and says when the processor is
// likely too slow.

const gb = 1_000_000_000;
const mib = 1024 ** 2;

export type OfferedModel = {
  /** Ollama's tag, such as qwen3:4b. */
  id: string;
  name: string;
  sizeBytes: number;
  memoryBytes: number;
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
  },
];

/** Storage left free beside a download, for the home's own data and updates. */
const storageMarginBytes = 2 * gb;

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
        // An older manager caps Ollama at half the host's memory in MiB.
        ollamaMemoryBytes ?? Math.floor(memory.totalBytes / (2 * mib)) * mib,
      ),
    },
    storage,
  };
}

/**
 * How a model sits with what's free: it fits while it takes under three
 * quarters, it's tight up to all of it, and it's too large beyond that.
 */
export type CapacityState = "fits" | "tight" | "tooLarge";

/** What a model takes of what's free for models, where the host says. */
export type Capacity = {
  neededBytes: number;
  roomBytes: number;
  state: CapacityState;
};

const tightFrom = 0.75;

function capacity(neededBytes: number, roomBytes: number): Capacity {
  const share = roomBytes > 0 ? neededBytes / roomBytes : Infinity;
  return {
    neededBytes,
    roomBytes: Math.max(0, roomBytes),
    state: share < tightFrom ? "fits" : share <= 1 ? "tight" : "tooLarge",
  };
}

/**
 * What a model takes of the memory free for models, and of the storage
 * free beside downloads under way, keeping 2 GB of storage spare. Null
 * where the host doesn't say.
 */
export function capacityOf(
  model: OfferedModel,
  check: HostCheck,
  reservedBytes = 0,
) {
  return {
    memory: check.memory && capacity(model.memoryBytes, check.memory.roomBytes),
    storage:
      check.storage &&
      capacity(
        model.sizeBytes,
        check.storage.freeBytes - storageMarginBytes - reservedBytes,
      ),
  };
}

/**
 * Whether a model fits the memory and storage this Sanctum has free: one
 * the host can't say it fits is never downloaded.
 */
export function fits(model: OfferedModel, check: HostCheck, reservedBytes = 0) {
  const { memory, storage } = capacityOf(model, check, reservedBytes);
  return (
    memory !== null &&
    memory.state !== "tooLarge" &&
    storage !== null &&
    storage.state !== "tooLarge"
  );
}

/** How a tag reads, where the page doesn't offer it: qwen3:14b as Qwen3 14B. */
export function modelName(tag: string) {
  const offered = offeredModels.find((model) => model.id === tag);
  if (offered) return offered.name;
  const tagStart = tag.lastIndexOf(":");
  const hasTag = tagStart > tag.lastIndexOf("/");
  const name = hasTag ? tag.slice(0, tagStart) : tag;
  const variant = hasTag ? tag.slice(tagStart + 1) : undefined;
  const named = name.charAt(0).toUpperCase() + name.slice(1);
  if (!variant || variant === "latest") return named;
  return /^\d+(\.\d+)?[bkm]$/i.test(variant)
    ? `${named} ${variant.toUpperCase()}`
    : `${named} ${variant}`;
}

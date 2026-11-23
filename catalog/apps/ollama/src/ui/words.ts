import type { OllamaStatus } from "../index";

// How Ollama's page says sizes, what this Sanctum has, and how a download is
// getting on. Sizes are in decimal gigabytes, as Ollama and the downloads
// themselves give them.

const gb = 1_000_000_000;

/** A size such as 1.4 GB, or 640 MB under a gigabyte. */
export function sizeText(bytes: number) {
  if (bytes === 0) return "0 MB";
  if (bytes < gb) return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
  return `${(bytes / gb).toFixed(1).replace(/\.0$/, "")} GB`;
}

/** A model's size and the memory it takes: "2.5 GB · uses about 3.2 GB of memory". */
export function modelLine(model: {
  sizeBytes: number;
  memoryBytes: number | null;
}) {
  return [
    sizeText(model.sizeBytes),
    model.memoryBytes !== null &&
      `uses about ${sizeText(model.memoryBytes)} of memory`,
  ]
    .filter(Boolean)
    .join(" · ");
}

type Capacity = NonNullable<OllamaStatus["offered"][number]["memory"]>;

// "3.2 of 4 GB": the room's unit, once.
function ofText({ neededBytes, roomBytes }: Capacity) {
  if (roomBytes < gb || neededBytes < gb) {
    return `${sizeText(neededBytes)} of ${sizeText(roomBytes)}`;
  }
  const needed = (neededBytes / gb).toFixed(1).replace(/\.0$/, "");
  return `${needed} of ${sizeText(roomBytes)}`;
}

const stateWords = { tight: "Tight", tooLarge: "Too large" } as const;

/**
 * What a model takes of the memory free for models: "Uses 2 of 4 GB
 * memory", or what's wrong with it first: "Tight · uses 3.2 of 4 GB memory",
 * "Too large · needs 6.5 of 4 GB memory".
 */
export function memoryCapacityLine(memory: Capacity) {
  if (memory.state === "fits") return `Uses ${ofText(memory)} memory`;
  const verb = memory.state === "tooLarge" ? "needs" : "uses";
  return `${stateWords[memory.state]} · ${verb} ${ofText(memory)} memory`;
}

/**
 * Its download, or, where storage is tight or too small, what it needs of
 * the storage free: "1.4 GB download", "Tight · needs 2 of 2.4 GB storage".
 */
export function storageCapacityLine(
  storage: Capacity | null,
  sizeBytes: number,
) {
  if (!storage || storage.state === "fits") {
    return `${sizeText(sizeBytes)} download`;
  }
  return `${stateWords[storage.state]} · needs ${ofText(storage)} storage`;
}

/** How much of the memory free for models it takes, from 0 to 100 and over. */
export function shareOf({ neededBytes, roomBytes }: Capacity) {
  return roomBytes > 0 ? Math.round((neededBytes / roomBytes) * 100) : Infinity;
}

/**
 * What's free for models, beside the section's heading: storage too where
 * it holds a model back.
 */
export function roomHint(offered: OllamaStatus["offered"]) {
  const memory = offered.find((model) => model.memory)?.memory;
  const storage = offered.find((model) => model.storage)?.storage;
  if (!memory) return undefined;
  const isStorageShort = offered.some(
    (model) => model.storage && model.storage.state !== "fits",
  );
  return isStorageShort && storage
    ? `${sizeText(memory.roomBytes)} of memory and ${sizeText(storage.roomBytes)} of storage free for models`
    : `${sizeText(memory.roomBytes)} of memory free for models`;
}

type Host = OllamaStatus["host"];

export function processorLine({ processor }: Host) {
  const named = processor.name
    ? `${processor.name}, ${processor.cores} cores`
    : `${processor.cores} cores`;
  return processor.isLikelySlow
    ? `Processor: ${named}. Likely too slow: an open question can take several minutes.`
    : `Processor: ${named}`;
}

export function memoryLine({ memory }: Host) {
  return memory
    ? `Memory: ${sizeText(memory.totalBytes)}, with ${sizeText(memory.roomBytes)} free for models`
    : null;
}

export function storageLine({ storage }: Host) {
  return storage ? `Storage: ${sizeText(storage.freeBytes)} free` : null;
}

type Download = OllamaStatus["downloads"][number];

/** How a download is getting on: "Downloading · 0.6 of 1.4 GB · about 2 minutes left". */
export function downloadLine(download: Download) {
  if (download.problem) return `Couldn't download: ${download.problem}`;
  if (download.totalBytes === 0) return "Starting the download";
  const parts = [
    "Downloading",
    `${(download.completedBytes / gb).toFixed(1)} of ${sizeText(download.totalBytes)}`,
  ];
  const left = download.totalBytes - download.completedBytes;
  if (download.bytesPerSecond && download.bytesPerSecond > 0 && left > 0) {
    const minutes = Math.round(left / download.bytesPerSecond / 60);
    parts.push(
      minutes < 1
        ? "less than a minute left"
        : minutes === 1
          ? "about a minute left"
          : `about ${minutes} minutes left`,
    );
  }
  return parts.join(" · ");
}

/** How far a download has come, from 0 to 100. */
export function percentOf(download: Download) {
  return download.totalBytes > 0
    ? Math.round((download.completedBytes / download.totalBytes) * 100)
    : 0;
}

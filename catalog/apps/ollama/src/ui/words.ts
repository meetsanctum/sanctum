import type { OllamaStatus } from "../index";

// How Ollama's page says sizes, what this Sanctum has, and how a download is
// getting on. Sizes are in decimal gigabytes, as Ollama and the downloads
// themselves give them.

const gb = 1_000_000_000;

/** A size such as 1.4 GB, or 640 MB under a gigabyte. */
export function sizeText(bytes: number) {
  if (bytes < gb) return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`;
  return `${(bytes / gb).toFixed(1).replace(/\.0$/, "")} GB`;
}

/** A model's size and the memory it takes: "2.5 GB · uses about 3.2 GB of memory". */
export function modelLine(model: {
  sizeBytes: number;
  memoryBytes: number | null;
  note?: string;
  isSuggested?: boolean;
}) {
  return [
    sizeText(model.sizeBytes),
    model.memoryBytes !== null &&
      `uses about ${sizeText(model.memoryBytes)} of memory`,
    model.note,
    model.isSuggested && "suggested for this Sanctum",
  ]
    .filter(Boolean)
    .join(" · ");
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

import type { OfferedModel } from "./models.js";
import type { Ollama } from "./ollama.js";

// The models downloading while the app runs, which outlast the call that
// started them: a model is gigabytes, minutes on a fast line. The page reads
// how far each has come, and Stop ends one. One that fails stays, saying why,
// until it's tried again or stopped; one that's done leaves the list, as the
// model is then on Sanctum.

type Download = {
  id: string;
  completedBytes: number;
  totalBytes: number;
  /** Bytes a second since it started, once it has some. */
  bytesPerSecond?: number;
  /** Why it stopped short. */
  problem?: string;
};

type TrackedDownload = {
  progress: Download;
  sizeBytes: number;
  controller: AbortController;
};

export function createDownloads(
  ollama: Ollama,
  log: (message: string) => void,
) {
  const downloads = new Map<string, TrackedDownload>();

  function stop(id: string) {
    const tracked = downloads.get(id);
    if (!tracked) return;
    tracked.controller.abort();
    downloads.delete(id);
  }

  return {
    list: () =>
      [...downloads.values()].map(({ progress }) => ({ ...progress })),
    isRunning(id: string) {
      const tracked = downloads.get(id);
      return tracked !== undefined && tracked.progress.problem === undefined;
    },
    // The registry reports progress one layer at a time. Reserve the full
    // estimate for each active pull until it finishes.
    reservedBytes() {
      let bytes = 0;
      for (const { progress, sizeBytes } of downloads.values()) {
        if (progress.problem === undefined) {
          bytes += Math.max(sizeBytes, progress.totalBytes);
        }
      }
      return bytes;
    },

    /** Starts a download or tries a failed one again. */
    start({ id, sizeBytes }: OfferedModel) {
      const progress: Download = { id, completedBytes: 0, totalBytes: 0 };
      const tracked: TrackedDownload = {
        progress,
        sizeBytes,
        controller: new AbortController(),
      };
      downloads.set(id, tracked);
      let startedAt: number | undefined;
      void ollama
        .pull(id, tracked.controller.signal, (update) => {
          const now = performance.now();
          startedAt ??= now;
          progress.completedBytes = update.completedBytes;
          progress.totalBytes = Math.max(sizeBytes, update.totalBytes);
          const seconds = (now - startedAt) / 1000;
          if (seconds >= 1 && update.transferredBytes > 0) {
            progress.bytesPerSecond = update.transferredBytes / seconds;
          }
        })
        .then(
          () => {
            if (downloads.get(id) === tracked) downloads.delete(id);
          },
          (error: unknown) => {
            if (tracked.controller.signal.aborted) return;
            const problem =
              (error instanceof Error ? error.message : String(error)) ||
              "Ollama couldn't finish the download";
            progress.problem = problem;
            log(`Couldn't download ${id}: ${problem}`);
          },
        );
    },

    /** Stops a download; Ollama keeps what came. */
    stop,

    /** Stops them all, as the app stops. */
    stopAll() {
      for (const id of downloads.keys()) stop(id);
    },
  };
}

export type Downloads = ReturnType<typeof createDownloads>;

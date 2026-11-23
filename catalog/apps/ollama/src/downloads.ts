import type { Ollama } from "./ollama.js";

// The models downloading while the app runs, which outlast the call that
// started them: a model is gigabytes, minutes on a fast line. The page reads
// how far each has come, and Stop ends one. One that fails stays, saying why,
// until it's tried again or stopped; one that's done leaves the list, as the
// model is then on Sanctum.

export type Download = {
  id: string;
  completedBytes: number;
  totalBytes: number;
  /** Bytes a second since it started, once it has some. */
  bytesPerSecond?: number;
  /** Why it stopped short. */
  problem?: string;
};

type Running = Download & {
  controller: AbortController;
  startedAt: number;
};

export function createDownloads(options: {
  ollama: () => Ollama;
  log: (message: string) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const downloads = new Map<string, Running>();

  function shown({ controller: _, startedAt: __, ...download }: Running) {
    return download;
  }

  return {
    list: (): Download[] => [...downloads.values()].map(shown),

    /** Starts a download, or tries a failed one again; one under way goes on. */
    start(id: string) {
      const current = downloads.get(id);
      if (current && !current.problem) return;
      const running: Running = {
        id,
        completedBytes: current?.completedBytes ?? 0,
        totalBytes: current?.totalBytes ?? 0,
        controller: new AbortController(),
        startedAt: now(),
      };
      downloads.set(id, running);
      let first: number | undefined;
      void options
        .ollama()
        .pull(id, running.controller.signal, (progress) => {
          first ??= progress.completedBytes;
          running.completedBytes = progress.completedBytes;
          running.totalBytes = progress.totalBytes;
          const seconds = (now() - running.startedAt) / 1000;
          if (seconds >= 1) {
            running.bytesPerSecond =
              (progress.completedBytes - first) / seconds;
          }
        })
        .then(
          () => {
            if (downloads.get(id) === running) downloads.delete(id);
          },
          (error: unknown) => {
            if (running.controller.signal.aborted) return;
            const problem =
              error instanceof Error ? error.message : String(error);
            options.log(`Couldn't download ${id}: ${problem}`);
            if (downloads.get(id) === running) running.problem = problem;
          },
        );
    },

    /** Stops a download; Ollama keeps what came. */
    stop(id: string) {
      const running = downloads.get(id);
      if (!running) return;
      running.controller.abort();
      downloads.delete(id);
    },

    /** Stops them all, as the app stops. */
    stopAll() {
      for (const id of [...downloads.keys()]) this.stop(id);
    },
  };
}

export type Downloads = ReturnType<typeof createDownloads>;

import { z } from "zod";

// Ollama's own API, at the address the manager gave the app, on a network
// it shares only with Ollama: the models it has, a model downloaded with its
// progress as it comes, and a model removed. Ollama's cloud models are off,
// and any it lists anyway are left out, so a model here always runs here.

const tags = z.object({
  models: z.array(
    z.object({
      name: z.string(),
      size: z.number(),
      remote_host: z.string().optional(),
      remote_model: z.string().optional(),
    }),
  ),
});

const pullLine = z.object({
  status: z.string().optional(),
  digest: z.string().optional(),
  total: z.number().optional(),
  completed: z.number().optional(),
  error: z.string().optional(),
});

/** How long a short question to Ollama may take. */
const askTimeoutMs = 10_000;

type OllamaModel = { id: string; sizeBytes: number };
type PullProgress = {
  completedBytes: number;
  totalBytes: number;
  transferredBytes: number;
};
const ollamaError = z.object({ error: z.string().min(1) });

export function createOllama(url: string, fetcher: typeof fetch = fetch) {
  async function ask(path: string, init: RequestInit = {}) {
    const response = await fetcher(`${url}${path}`, {
      ...init,
      redirect: "error",
      signal: init.signal ?? AbortSignal.timeout(askTimeoutMs),
    });
    if (!response.ok) {
      const said = ollamaError.safeParse(
        await response.json().catch(() => null),
      );
      throw new Error(
        said.success ? said.data.error : `Ollama answered ${response.status}`,
      );
    }
    return response;
  }

  return {
    /** The models on this Sanctum. */
    async models(): Promise<OllamaModel[]> {
      const answer = tags.parse(await (await ask("/api/tags")).json());
      return answer.models
        .filter(
          (model) =>
            !model.remote_host &&
            !model.remote_model &&
            !model.name.endsWith("-cloud"),
        )
        .map((model) => ({ id: model.name, sizeBytes: model.size }));
    },

    /**
     * Downloads a model, saying how far it has come as Ollama reports each
     * part. Stopped, Ollama keeps what came, so the next download goes on
     * from there.
     */
    async pull(
      model: string,
      signal: AbortSignal,
      onProgress: (progress: PullProgress) => void,
    ) {
      const response = await ask("/api/pull", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, stream: true }),
        signal,
      });
      if (!response.body) throw new Error("Ollama sent nothing");
      const parts = new Map<string, Omit<PullProgress, "transferredBytes">>();
      const decoder = new TextDecoder();
      let rest = "";
      let isDone = false;
      let transferredBytes = 0;
      const read = (line: string) => {
        if (!line.trim()) return;
        const said = pullLine.safeParse(JSON.parse(line));
        if (!said.success) return;
        if (said.data.error) throw new Error(said.data.error);
        const { digest, total, completed } = said.data;
        if (digest && total) {
          const part = { totalBytes: total, completedBytes: completed ?? 0 };
          const previous = parts.get(digest);
          // The first report for a layer can include already cached bytes.
          if (previous) {
            transferredBytes += Math.max(
              0,
              part.completedBytes - previous.completedBytes,
            );
          }
          parts.set(digest, part);
          let totalBytes = 0;
          let completedBytes = 0;
          for (const part of parts.values()) {
            totalBytes += part.totalBytes;
            completedBytes += part.completedBytes;
          }
          onProgress({ totalBytes, completedBytes, transferredBytes });
        }
        if (said.data.status === "success") isDone = true;
      };
      for await (const bytes of response.body as unknown as AsyncIterable<Uint8Array>) {
        rest += decoder.decode(bytes, { stream: true });
        let end: number;
        while ((end = rest.indexOf("\n")) >= 0) {
          read(rest.slice(0, end));
          rest = rest.slice(end + 1);
        }
      }
      read(rest + decoder.decode());
      if (!isDone) throw new Error("The download broke off");
    },

    async remove(model: string) {
      await ask("/api/delete", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
      });
    },
  };
}

export type Ollama = ReturnType<typeof createOllama>;

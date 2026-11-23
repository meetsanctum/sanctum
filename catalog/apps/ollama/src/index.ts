import {
  ActionError,
  defineAction,
  defineApp,
  type AppContext,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import { createDownloads, type Downloads } from "./downloads.js";
import {
  fits,
  hostCheck,
  modelName,
  offeredModels,
  suggestedModel,
} from "./models.js";
import { createOllama, type Ollama } from "./ollama.js";

// Ollama: AI models on Sanctum itself. The manager runs Ollama for it (the
// `ollama` service), and the app manages its models: its page checks what
// this Sanctum has, offers models that fit, downloads one with its progress,
// stops a download and removes a model. Ollama's models stay on Sanctum, and
// what's asked of them never leaves the home. The page is in ./ui.

// We pass model IDs back exactly as Ollama lists them, including namespaced
// names. Downloads check the catalog and removal checks the installed list.
const modelId = z.string().min(1);

const hostShape = z.object({
  processor: z.object({
    name: z.string().nullable(),
    cores: z.number(),
    isLikelySlow: z.boolean(),
  }),
  memory: z
    .object({ totalBytes: z.number(), roomBytes: z.number() })
    .nullable(),
  storage: z.object({ freeBytes: z.number() }).nullable(),
});

const statusShape = z.object({
  /** Whether Ollama answered: it may still be starting, or downloading itself. */
  isAnswering: z.boolean(),
  host: hostShape,
  models: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      sizeBytes: z.number(),
      memoryBytes: z.number().nullable(),
    }),
  ),
  downloads: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      completedBytes: z.number(),
      totalBytes: z.number(),
      bytesPerSecond: z.number().optional(),
      problem: z.string().optional(),
    }),
  ),
  // Those that fit and aren't here yet, smallest first.
  offered: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      sizeBytes: z.number(),
      memoryBytes: z.number(),
      note: z.string().optional(),
      isSuggested: z.boolean(),
    }),
  ),
});

export type OllamaStatus = z.infer<typeof statusShape>;

/** The app, with Ollama's fetch a test may replace. */
export function createOllamaApp(options: { fetch?: typeof fetch } = {}) {
  let connection:
    { ollama: Ollama; downloads: Downloads; memoryBytes?: number } | undefined;

  async function connect(ctx: AppContext) {
    if (connection) return connection;
    const service = await ctx.services.connection("ollama");
    if (connection) return connection;
    const url = service.http?.url;
    if (!url) throw new Error("The manager gave no address for Ollama");
    const ollama = createOllama(url, options.fetch);
    connection = {
      ollama,
      downloads: createDownloads(ollama, (message) => ctx.log(message)),
      memoryBytes:
        typeof service.memoryBytes === "number"
          ? service.memoryBytes
          : undefined,
    };
    return connection;
  }

  const status = defineAction({
    id: "ollama.status",
    title: "Models on Sanctum",
    tier: "read",
    input: z.object({}),
    output: statusShape,
    async run(ctx) {
      const { ollama, downloads, memoryBytes } = await connect(ctx);
      const [resources, models] = await Promise.all([
        ctx.host.resources(),
        ollama.models().catch(() => null),
      ]);
      const check = hostCheck(resources, memoryBytes);
      const underWay = downloads.list();
      const here = new Set([
        ...(models ?? []).map((model) => model.id),
        ...underWay.map((download) => download.id),
      ]);
      const reservedBytes = downloads.reservedBytes();
      const suggested = suggestedModel(check, reservedBytes);
      return {
        isAnswering: models !== null,
        host: check,
        models: (models ?? []).map((model) => ({
          id: model.id,
          name: modelName(model.id),
          sizeBytes: model.sizeBytes,
          memoryBytes:
            offeredModels.find((offered) => offered.id === model.id)
              ?.memoryBytes ?? null,
        })),
        downloads: underWay.map((download) => ({
          ...download,
          name: modelName(download.id),
        })),
        offered: offeredModels
          .filter(
            (model) => !here.has(model.id) && fits(model, check, reservedBytes),
          )
          .map((model) => ({ ...model, isSuggested: model.id === suggested })),
      };
    },
  });

  const download = defineAction({
    id: "ollama.download",
    title: "Download a model",
    tier: "write",
    input: z.object({
      model: modelId,
      // The household read that this Sanctum is likely too slow.
      anyway: z.boolean().optional(),
    }),
    output: z.object({}),
    async run(ctx, { model, anyway }) {
      const offered = offeredModels.find((each) => each.id === model);
      if (!offered) throw new ActionError("not_found");
      const connected = await connect(ctx);
      const { ollama, downloads, memoryBytes } = connected;
      if (downloads.isRunning(model)) return {};
      if ((await ollama.models()).some((each) => each.id === model)) return {};
      const check = hostCheck(await ctx.host.resources(), memoryBytes);
      if (connection !== connected) throw new ActionError("conflict");
      if (downloads.isRunning(model)) return {};
      if (
        !fits(offered, check, downloads.reservedBytes()) ||
        (check.processor.isLikelySlow && !anyway)
      ) {
        throw new ActionError("conflict");
      }
      downloads.start(offered);
      return {};
    },
  });

  const stop = defineAction({
    id: "ollama.stop",
    title: "Stop a download",
    tier: "write",
    input: z.object({ model: modelId }),
    output: z.object({}),
    async run(ctx, { model }) {
      const { downloads } = await connect(ctx);
      downloads.stop(model);
      return {};
    },
  });

  const remove = defineAction({
    id: "ollama.remove",
    title: "Remove a model",
    tier: "destructive",
    input: z.object({ model: modelId }),
    output: z.object({}),
    async run(ctx, { model }) {
      const { ollama, downloads } = await connect(ctx);
      const models = await ollama.models();
      if (!models.some((each) => each.id === model)) {
        throw new ActionError("not_found");
      }
      downloads.stop(model);
      await ollama.remove(model);
      return {};
    },
  });

  return defineApp({
    id: "sanctum.ollama",
    name: "Ollama",
    version: "0.1.0",
    core: "^2.0.0",
    summary: "AI models on Sanctum itself, so what's asked stays in your home.",
    icon: { glyph: "cpu", color: "iris" },
    pages: ["main"],
    permissions: [
      {
        id: "services:ollama",
        reason: "To run AI models on Sanctum.",
        needed: true,
      },
    ],
    actions: [status, download, stop, remove],
    events: [],
    async start(ctx) {
      await connect(ctx);
    },
    async stop() {
      connection?.downloads.stopAll();
      connection = undefined;
    },
  });
}

export default createOllamaApp();

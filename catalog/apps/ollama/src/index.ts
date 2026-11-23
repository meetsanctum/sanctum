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

export const servicesPermission = "services:ollama";

const modelId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]*(:[a-z0-9._-]+)?$/, "an Ollama model's tag");

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
  let ollama: Ollama | undefined;
  let memoryBytes: number | undefined;
  let downloads: Downloads | undefined;

  async function connect(ctx: AppContext) {
    if (ollama && downloads) return { ollama, downloads };
    const connection = await ctx.services.connection("ollama");
    const url = connection.http?.url;
    if (!url) throw new Error("The manager gave no address for Ollama");
    memoryBytes =
      typeof connection.memoryBytes === "number"
        ? connection.memoryBytes
        : undefined;
    const reached = createOllama(url, options.fetch);
    ollama = reached;
    downloads = createDownloads({
      ollama: () => reached,
      log: (message) => ctx.log(message),
    });
    return { ollama: reached, downloads };
  }

  const status = defineAction({
    id: "ollama.status",
    title: "Models on Sanctum",
    tier: "read",
    input: z.object({}),
    output: statusShape,
    async run(ctx) {
      const { ollama, downloads } = await connect(ctx);
      const check = hostCheck(await ctx.host.resources(), memoryBytes);
      let isAnswering = true;
      const models = await ollama.models().catch(() => {
        isAnswering = false;
        return [];
      });
      const underWay = downloads.list();
      const here = new Set([
        ...models.map((model) => model.id),
        ...underWay.map((download) => download.id),
      ]);
      const suggested = suggestedModel(check);
      return {
        isAnswering,
        host: check,
        models: models.map((model) => ({
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
          .filter((model) => !here.has(model.id) && fits(model, check))
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
      const { downloads } = await connect(ctx);
      const offered = offeredModels.find((each) => each.id === model);
      if (!offered) throw new ActionError("not_found");
      const check = hostCheck(await ctx.host.resources(), memoryBytes);
      if (!fits(offered, check)) throw new ActionError("conflict");
      if (check.processor.isLikelySlow && !anyway) {
        throw new ActionError("conflict");
      }
      downloads.start(model);
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
      downloads.stop(model);
      const models = await ollama.models();
      if (!models.some((each) => each.id === model)) {
        throw new ActionError("not_found");
      }
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
        id: servicesPermission,
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
      downloads?.stopAll();
      ollama = undefined;
      downloads = undefined;
    },
  });
}

export default createOllamaApp();

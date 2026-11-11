import {
  defineApp,
  defineEntityType,
  type AppContext,
  type AppDefinition,
  type StartInfo,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

import { base } from "./app-apart-support.js";

const noteType = defineEntityType({
  id: "test.note",
  title: "Note",
  state: z.object({ text: z.string() }),
});
export const id = "test.owner";

export type Seen = StartInfo[];

// One version of the app, publishing these and doing what it's told.
export function version(
  number: string,
  options: {
    seen?: Seen;
    notes?: string[];
    start?: (ctx: AppContext) => Promise<void>;
    settings?: z.ZodObject;
  } = {},
): AppDefinition {
  return defineApp({
    ...base,
    id,
    version: number,
    permissions: [],
    actions: [],
    provides: { entities: [noteType] },
    ...(options.settings ? { settings: options.settings as never } : {}),
    start: async (ctx: AppContext, info: StartInfo) => {
      options.seen?.push(info);
      for (const key of options.notes ?? []) {
        await ctx.entities.publish({
          type: noteType.id,
          key,
          name: key,
          state: { text: key },
        });
      }
      await options.start?.(ctx);
    },
  });
}

export const falls = async () => {
  throw new Error("It fell over");
};

import { z } from "zod";

import type { EntityTypeDefinition } from "./entities.js";
import type { AppDefinition } from "./index.js";

// Entities that run, such as moods: a standard type with a run (entities.ts)
// is run through one action of the app that provides it, which says so with
// `runs`. A reader such as the core's `run` tool for AI agents finds that
// action by the entity's app and type, and calls it with the entity's
// `input`, so it names neither the app nor the action.

/**
 * An app's actions that run entities: each runs a standard type with a run
 * that the app provides, in an everyday tier, answering the type's run
 * output, and each such type has one action that runs it. One offered to AI
 * agents needs the type's own switch, so switching moods off for them stops
 * `run` too.
 */
export function assertEntityRuns(
  app: AppDefinition,
  standardTypes: readonly EntityTypeDefinition[],
) {
  const provided = new Set((app.provides?.entities ?? []).map(({ id }) => id));
  const ran = new Set<string>();
  for (const action of app.actions) {
    if (action.runs === undefined) continue;
    const type = standardTypes.find((each) => each.id === action.runs);
    if (!type?.run) {
      throw new Error(
        `"${action.id}" runs ${String(action.runs)}, which is not a standard type that runs`,
      );
    }
    if (!provided.has(type.id)) {
      throw new Error(
        `"${action.id}" runs ${type.id}, which the app does not provide`,
      );
    }
    if (action.tier !== "read" && action.tier !== "write") {
      throw new Error(`"${action.id}" runs ${type.id}, so it is read or write`);
    }
    if (!sameSchema(action.output, type.run.output)) {
      throw new Error(
        `"${action.id}" runs ${type.id}, so it answers what running one answers`,
      );
    }
    if (action.assistant && !action.assistant.needs?.includes(type.id)) {
      throw new Error(
        `"${action.id}" runs ${type.id}, so AI agents need ${type.id} to use it`,
      );
    }
    if (ran.has(type.id)) {
      throw new Error(`Two of the app's actions run ${type.id}`);
    }
    ran.add(type.id);
  }
}

// The same schema, as JSON says it: a zod schema, from whichever copy of zod
// made it, or the JSON Schema a manifest holds.
export function sameSchema(schema: z.ZodType, other: z.ZodType | object) {
  const json = (each: z.ZodType | object) => {
    const { $schema: _, ...rest } = (
      "_zod" in each ? z.toJSONSchema(each as z.ZodType) : each
    ) as Record<string, unknown>;
    return JSON.stringify(rest);
  };
  return json(schema) === json(other);
}

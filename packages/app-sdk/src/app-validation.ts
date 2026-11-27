import type { z } from "zod";

import type { AppDefinition } from "./app-definition.js";
import type { EntityTypeDefinition } from "./entities.js";
import { assertWidgets } from "./widgets.js";

export const memberId = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

export function isSchema(value: unknown) {
  return typeof (value as z.ZodType | undefined)?.safeParse === "function";
}

export function assertUniqueIds(kind: string, ids: readonly string[]) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`Duplicate ${kind} id "${id}"`);
    }
    seen.add(id);
  }
}

export function assertProvides(
  app: AppDefinition,
  standardEntityTypes: readonly EntityTypeDefinition[],
) {
  const provides = app.provides ?? {};
  if (typeof provides !== "object") {
    throw new Error("An app's provides must be an object");
  }
  const types = provides.entities ?? [];
  const widgets = provides.widgets ?? [];
  if (!Array.isArray(types) || !Array.isArray(widgets)) {
    throw new Error("An app provides lists of entity types and widgets");
  }
  for (const type of types) {
    const id = String(type?.id);
    if (!type || typeof type.title !== "string" || !isSchema(type.state)) {
      throw new Error(`Entity type "${id}" needs a title and a state schema`);
    }
    const standard = standardEntityTypes.some((each) => each.id === type.id);
    if (standard !== (type.standard === true)) {
      throw new Error(
        standard
          ? `"${id}" is a standard entity type: use the core's definition`
          : `"${id}" is not one of the core's standard entity types`,
      );
    }
    if (!standard && type.run !== undefined) {
      throw new Error(
        `Only standard entity types can run, but "${id}" is custom`,
      );
    }
    if (!standard && !memberId.test(id)) {
      throw new Error(
        `Entity type "${id}" must be namespaced, such as naturalLight.target`,
      );
    }
  }
  assertUniqueIds(
    "entity type",
    types.map((type) => type.id),
  );
  // A widget's id is the type of the entities that hold its cards.
  assertWidgets(app, [
    ...types.map((type) => type.id),
    ...standardEntityTypes.map((type) => type.id),
  ]);
  assertUniqueIds(
    "widget",
    widgets.map((widget) => widget.id),
  );
}

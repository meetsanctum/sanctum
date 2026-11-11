import { namedKinds, type NamedKind } from "@meetsanctum/app-sdk";
import type { z } from "zod";

import { schemaAt, schemaCheck } from "../app-host/contract.js";

// The rooms, zones, devices and entities a node's config names: the fields
// its piece's schema declares with names() or entityOf(), found by walking
// the schema along the config as parsing it would, since the piece acts on
// what its parse gives. A union follows the option the config takes, as the
// lights pieces' place does for a room or a zone, and a default, a fallback
// or a pipe names what it gives. Ids are strings, so a field that only
// happens to hold one names nothing. Each comes with its field's path in the
// config, such as place.id, so a problem with it can mark that field in the
// editor.

export type Named =
  | { kind: NamedKind; id: string; field: string }
  // An entity of a type, by its key.
  | { kind: "entity"; type: string; id: string; field: string };

type Def = { type: string } & Record<string, unknown>;

const wrappers = new Set(["optional", "nullable", "nonoptional", "readonly"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parse(schema: z.ZodType, value: unknown) {
  try {
    return schema.safeParse(value);
  } catch {
    return undefined;
  }
}

// Whether this field names something, which goes no deeper, noting what its value
// names if it holds one.
function noteNamed(
  names: unknown,
  entityOf: unknown,
  value: unknown,
  found: Named[],
  path: readonly string[],
) {
  const id = typeof value === "string" ? value : undefined;
  const field = path.join(".");
  if (namedKinds.includes(names as NamedKind)) {
    if (id !== undefined) found.push({ kind: names as NamedKind, id, field });
    return true;
  }
  if (typeof entityOf === "string") {
    if (id !== undefined) {
      found.push({ kind: "entity", type: entityOf, id, field });
    }
    return true;
  }
  return false;
}

function walk(
  schema: z.ZodType,
  value: unknown,
  found: Named[],
  path: readonly string[],
  isOutput = false,
) {
  const meta = schema.meta?.() as
    { names?: unknown; entityOf?: unknown } | undefined;
  if (noteNamed(meta?.names, meta?.entityOf, value, found, path)) return;
  const def = schema._zod.def as Def;
  const inner = (key: string) => def[key] as z.ZodType;
  const visit = (child: z.ZodType, each: unknown, at: PropertyKey[] = []) =>
    walk(child, each, found, [...path, ...at.map(String)], isOutput);
  if (wrappers.has(def.type)) {
    visit(inner("innerType"), value);
  } else if (def.type === "default" || def.type === "prefault") {
    if (!isOutput && value === undefined) {
      // Defaults are already output; prefaults still pass through the
      // inner schema. Do not transform a default a second time.
      walk(
        inner("innerType"),
        def.defaultValue,
        found,
        path,
        def.type === "default",
      );
    } else {
      visit(inner("innerType"), value);
    }
  } else if (def.type === "catch") {
    if (isOutput || parse(inner("innerType"), value)?.success) {
      visit(inner("innerType"), value);
    } else {
      const result = parse(schema, value);
      if (result?.success) {
        walk(inner("innerType"), result.data, found, path, true);
      }
    }
  } else if (def.type === "pipe") {
    if (isOutput) {
      visit(inner("out"), value);
    } else {
      visit(inner("in"), value);
      const result = parse(inner("in"), value);
      if (result?.success) visit(inner("out"), result.data);
    }
  } else if (def.type === "lazy") {
    visit((def.getter as () => z.ZodType)(), value);
  } else if (def.type === "object" && isRecord(value)) {
    const shape = def.shape as Record<string, z.ZodType>;
    for (const [key, field] of Object.entries(shape)) {
      visit(field, value[key], [key]);
    }
    if (def.catchall) {
      for (const [key, each] of Object.entries(value)) {
        if (!Object.hasOwn(shape, key)) visit(inner("catchall"), each, [key]);
      }
    }
  } else if (def.type === "array" && Array.isArray(value)) {
    for (const [index, each] of value.entries()) {
      visit(inner("element"), each, [index]);
    }
  } else if (def.type === "tuple" && Array.isArray(value)) {
    const items = def.items as z.ZodType[];
    for (const [index, item] of items.entries()) {
      visit(item, value[index], [index]);
    }
    if (def.rest) {
      for (const [index, each] of value.entries()) {
        if (index >= items.length) visit(inner("rest"), each, [index]);
      }
    }
  } else if (def.type === "record" && isRecord(value)) {
    // A key that names something is the record's own field.
    for (const [key, each] of Object.entries(value)) {
      visit(inner("keyType"), key, [key]);
      visit(inner("valueType"), each, [key]);
    }
  } else if (def.type === "union") {
    const option = (def.options as z.ZodType[]).find(
      (each) => parse(each, value)?.success,
    );
    if (option) visit(option, value);
  } else if (def.type === "intersection") {
    visit(inner("left"), value);
    visit(inner("right"), value);
  }
}

/** What a config names by the fields its schema declares, in order. */
export function namedIn(schema: z.ZodType, config: unknown): Named[] {
  const found: Named[] = [];
  walk(schema, config, found, []);
  return found;
}

type JsonSchema = Record<string, unknown>;

function walkJson(
  root: JsonSchema,
  schema: JsonSchema,
  pointer: string,
  value: unknown,
  found: Named[],
  path: readonly string[],
  references: ReadonlySet<string> = new Set(),
) {
  if (value === undefined) value = schema.default;
  if (noteNamed(schema.names, schema.entityOf, value, found, path)) return;
  const visit = (
    child: unknown,
    atSchema: string[],
    each: unknown,
    at: PropertyKey[] = [],
  ) => {
    if (isRecord(child))
      walkJson(
        root,
        child,
        pointer +
          atSchema
            .map((part) => `/${part.replace(/~/g, "~0").replace(/\//g, "~1")}`)
            .join(""),
        each,
        found,
        [...path, ...at.map(String)],
        // Only going deeper into the value makes progress.
        each === value ? references : new Set(),
      );
  };
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#")) {
    const target = decodeURIComponent(schema.$ref.slice(1));
    const referred = schemaAt(root, target);
    if (isRecord(referred) && !references.has(target)) {
      walkJson(
        root,
        referred,
        target,
        value,
        found,
        path,
        new Set([...references, target]),
      );
    }
  }
  for (const key of ["anyOf", "oneOf"] as const) {
    const options = schema[key];
    if (Array.isArray(options)) {
      const index = options.findIndex(
        (each, index) =>
          isRecord(each) &&
          schemaCheck(root, `${pointer}/${key}/${index}`)(value).success,
      );
      if (index >= 0) visit(options[index], [key, String(index)], value);
    }
  }
  if (Array.isArray(schema.allOf)) {
    for (const [index, each] of schema.allOf.entries()) {
      visit(each, ["allOf", String(index)], value);
    }
  }
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, field] of Object.entries(properties)) {
      const own = Object.hasOwn(value, key) ? value[key] : undefined;
      visit(field, ["properties", key], own, [key]);
    }
    for (const key of Object.keys(value)) {
      visit(schema.propertyNames, ["propertyNames"], key, [key]);
    }
    if (isRecord(schema.additionalProperties)) {
      for (const [key, each] of Object.entries(value)) {
        if (!Object.hasOwn(properties, key)) {
          visit(schema.additionalProperties, ["additionalProperties"], each, [
            key,
          ]);
        }
      }
    }
  } else if (Array.isArray(value)) {
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    for (const [index, item] of prefix.entries()) {
      visit(item, ["prefixItems", String(index)], value[index], [index]);
    }
    for (const [index, each] of value.entries()) {
      if (index >= prefix.length) visit(schema.items, ["items"], each, [index]);
    }
  }
}

/** The same, by the JSON Schema of an app's piece, from its manifest. */
export function namedInSchema(schema: JsonSchema, config: unknown): Named[] {
  const found: Named[] = [];
  walkJson(schema, schema, "", config, found, []);
  return found;
}

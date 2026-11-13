import { isDeepStrictEqual } from "node:util";

import {
  appManifestSchema,
  standardEntityTypes,
  tierSchema,
  tileShapeProblemsOf,
  widgetEntityType,
  type AppDefinition,
  type StaticManifest,
  type Tier,
  type WidgetDefinition,
} from "@meetsanctum/app-sdk";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { z } from "zod";

// What the core knows of an app, from its static manifest: the core checks
// every call across the line between it and the app with the JSON Schemas
// there, and never with the app's own zod objects, which parse inside the
// app's container. So a refinement only the app can run still holds, and what
// the core keeps needs nothing of the app's code.

// Formats aren't checked, since zod writes a pattern beside each one, and
// patterns are JavaScript's own. A default fills in what its field leaves out,
// on a copy of the value checked. Only what a value owns counts, so `constructor`
// in a schema doesn't read what every object inherits.
const ajv = new Ajv2020({
  strict: false,
  allErrors: true,
  useDefaults: true,
  validateFormats: false,
  unicodeRegExp: false,
  ownProperties: true,
});
const schemaKeys = new WeakMap<object, string>();
let nextSchemaKey = 0;

export type Issue = { path: (string | number)[]; message: string };
export type Checked =
  | { success: true; data: unknown }
  // `broken`: the schema failed, so this says nothing about the value.
  | { success: false; issues: Issue[]; broken?: true };
export type SchemaCheck = (value: unknown) => Checked;
export type JsonSchema = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonSchema =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A local JSON pointer, including the root, within one manifest schema. */
export function schemaAt(root: object, pointer: string): unknown {
  return pointer
    .split("/")
    .slice(1)
    .reduce<unknown>(
      (value, key) =>
        typeof value === "object" && value !== null
          ? (value as JsonSchema)[key.replace(/~1/g, "/").replace(/~0/g, "~")]
          : undefined,
      root,
    );
}

const failed = (message: string): Checked => ({
  success: false,
  issues: [{ path: [], message }],
});

function issuesOf(errors: NonNullable<ValidateFunction["errors"]>): Issue[] {
  const byPath = new Map<string, Issue>();
  for (const { instancePath, keyword, params, message } of errors) {
    const missing =
      keyword === "required" ? [String(params.missingProperty)] : [];
    const path = [
      ...instancePath
        .split("/")
        .slice(1)
        .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))
        .map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
      ...missing,
    ];
    // A union's options each say why they refuse: the first says enough.
    const key = JSON.stringify(path);
    if (!byPath.has(key)) {
      byPath.set(key, { path, message: message ?? "It does not fit" });
    }
  }
  return [...byPath.values()];
}

// Ajv fills object and tuple defaults, but deliberately skips defaults inside
// unions. Check each option on its own copy so only the matching branch's
// defaults reach the value. No app code runs to resolve any of them.
// The references being followed, innermost last. Checks run to the end without
// waiting, so one list serves them all.
const following: Array<{ target: string; value: unknown }> = [];

function fillDefaults(
  root: object,
  schema: JsonSchema,
  pointer: string,
  value: unknown,
): unknown {
  if (value === undefined) value = structuredClone(schema.default);
  if (
    value !== undefined &&
    typeof schema.$ref === "string" &&
    schema.$ref.startsWith("#")
  ) {
    const target = decodeURIComponent(schema.$ref.slice(1));
    // The same reference with the same value again gets nowhere. Going on would
    // fill the stack, and again at every level on the way back: seconds on a
    // Pi, for a schema that refers to itself without end.
    const again = following.some(
      (each) => each.target === target && isDeepStrictEqual(each.value, value),
    );
    if (!again) {
      following.push({ target, value });
      try {
        const checked = schemaCheck(root, target)(value);
        if (checked.success) value = checked.data;
      } finally {
        following.pop();
      }
    }
  }
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const options = schema[key];
    if (!Array.isArray(options)) continue;
    for (const [index, option] of options.entries()) {
      if (!isRecord(option)) continue;
      const checked = schemaCheck(root, `${pointer}/${key}/${index}`)(value);
      if (checked.success) {
        value = checked.data;
        if (key !== "allOf") break;
      }
    }
  }
  if (value === undefined) return value;
  const visit = (child: unknown, atSchema: string[], each: unknown) =>
    isRecord(child)
      ? fillDefaults(
          root,
          child,
          pointer +
            atSchema
              .map(
                (part) => `/${part.replace(/~/g, "~0").replace(/\//g, "~1")}`,
              )
              .join(""),
          each,
        )
      : each;
  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [key, child] of Object.entries(properties)) {
      // Only what the value owns: `__proto__` or `constructor` in a schema must
      // not lead to what every object inherits.
      const own = Object.hasOwn(value, key) ? value[key] : undefined;
      const each = visit(child, ["properties", key], own);
      if (each !== undefined) {
        Object.defineProperty(value, key, {
          value: each,
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(properties, key)) {
        value[key] = visit(
          schema.additionalProperties,
          ["additionalProperties"],
          value[key],
        );
      }
    }
  } else if (Array.isArray(value)) {
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    for (const [index, child] of prefix.entries()) {
      const each = visit(child, ["prefixItems", String(index)], value[index]);
      if (each !== undefined) value[index] = each;
    }
    for (let index = prefix.length; index < value.length; index++) {
      value[index] = visit(schema.items, ["items"], value[index]);
    }
  }
  return value;
}

/** A check against a JSON Schema from a manifest, compiled when first used. */
export function schemaCheck(schema: object, pointer = ""): SchemaCheck {
  let validate: ValidateFunction | undefined;
  return (value) => {
    try {
      if (!validate && pointer) {
        // A union option may refer to definitions elsewhere in its schema.
        // Compile it in that schema's scope, not as a separate document.
        let key = schemaKeys.get(schema);
        if (!key) {
          key = `urn:sanctum:schema:${nextSchemaKey++}`;
          ajv.addSchema(schema, key);
          schemaKeys.set(schema, key);
        }
        validate = ajv.getSchema(
          `${key}#${encodeURI(pointer).replace(/#/g, "%23")}`,
        );
        if (!validate) {
          return {
            ...failed("Its schema could not be found"),
            broken: true,
          };
        }
      }
      validate ??= ajv.compile(schema);
    } catch (error) {
      return {
        ...failed(
          `Its schema failed (${error instanceof Error ? error.message : String(error)})`,
        ),
        broken: true,
      };
    }
    let data: unknown;
    try {
      data = structuredClone(value);
    } catch {
      return failed("It isn't plain data");
    }
    // A schema that refers to itself without end overflows the stack here.
    try {
      const current = schemaAt(schema, pointer);
      if (isRecord(current)) {
        data = fillDefaults(schema, current, pointer, data);
      }
      return validate(data)
        ? { success: true, data }
        : { success: false, issues: issuesOf(validate.errors ?? []) };
    } catch (error) {
      return {
        ...failed(
          `Its schema failed (${error instanceof Error ? error.message : String(error)})`,
        ),
        broken: true,
      };
    }
  };
}

// The core's own zod objects, as a check like any other.
function zodCheck(schema: z.ZodType): SchemaCheck {
  return (value) => {
    const parsed = schema.safeParse(value);
    return parsed.success
      ? { success: true, data: parsed.data }
      : {
          success: false,
          issues: parsed.error.issues.map(({ path, message }) => ({
            path: path.map((part) =>
              typeof part === "number" ? part : String(part),
            ),
            message,
          })),
        };
  };
}

/** An action as its manifest declares it. */
export type DeclaredAction = {
  id: string;
  title: string;
  tier: Tier;
  input: SchemaCheck;
  output: SchemaCheck;
  // Its input's JSON Schema, for a workflow piece's config.
  schema: JsonSchema;
};

/** A workflow trigger as its manifest declares it. */
export type DeclaredTrigger = {
  id: string;
  title: string;
  // The app's event that fires it.
  event: string;
  config: SchemaCheck;
  schema: JsonSchema;
  words: StaticManifest["provides"]["triggers"][number]["words"];
  needs: readonly string[];
};

/** A workflow condition or step: an action of the app's, with its words. */
export type DeclaredPiece = DeclaredAction & {
  words: StaticManifest["provides"]["steps"][number]["words"];
  needs: readonly string[];
};

/** One app's workflow pieces, as the Workflows module looks them up. */
export type AppPieces = {
  app: string;
  triggers: ReadonlyMap<string, DeclaredTrigger>;
  conditions: ReadonlyMap<string, DeclaredPiece>;
  steps: ReadonlyMap<string, DeclaredPiece>;
};

/** A type of entity an app may publish, with the check its state must pass. */
export type DeclaredEntityType = { id: string; state: SchemaCheck };

export type AppContract = {
  actions: ReadonlyMap<string, DeclaredAction>;
  events: ReadonlyMap<string, SchemaCheck>;
  entityTypes: ReadonlyMap<string, DeclaredEntityType>;
  pieces: AppPieces;
};

// A card's checks and buttons must run the app's own read or write actions
// with an input they take (widgets.ts), read here from the manifest.
function widgetState(widget: WidgetDefinition, manifest: StaticManifest) {
  const app = {
    pages: manifest.pages,
    actions: manifest.actions.map((action) => {
      const input = schemaCheck(action.input);
      return {
        id: action.id,
        tier: action.tier,
        input: { safeParse: (value: unknown) => input(value) },
      };
    }),
  } as unknown as Pick<AppDefinition, "actions" | "pages">;
  return zodCheck(widgetEntityType(widget, app).state);
}

// JSON has no way to say an input may be left out altogether, so that is the
// app's own schema to judge.
function inputCheck(schema: object): SchemaCheck {
  const check = schemaCheck(schema);
  return (value) =>
    value === undefined ? { success: true, data: value } : check(value);
}

export function contractOf(manifest: StaticManifest): AppContract {
  const actions = new Map<string, DeclaredAction>(
    manifest.actions.map((action) => [
      action.id,
      {
        id: action.id,
        title: action.title,
        tier: action.tier,
        input: inputCheck(action.input),
        output: schemaCheck(action.output),
        schema: action.input as JsonSchema,
      },
    ]),
  );
  const piece = ({
    id,
    words,
    needs,
  }: StaticManifest["provides"]["steps"][number]): [string, DeclaredPiece] => {
    const action = actions.get(id);
    if (!action) throw new Error(`Its piece ${id} is not one of its actions`);
    return [id, { ...action, words, needs }];
  };
  const entityTypes = new Map<string, DeclaredEntityType>();
  for (const type of manifest.provides.entities) {
    // The core's own definition for a standard type, whatever copy of the
    // SDK the app brought.
    const standard = standardEntityTypes.find((each) => each.id === type.id);
    entityTypes.set(type.id, {
      id: type.id,
      state: standard ? zodCheck(standard.state) : schemaCheck(type.state),
    });
  }
  for (const widget of manifest.provides.widgets) {
    entityTypes.set(widget.id, {
      id: widget.id,
      state: widgetState(widget as unknown as WidgetDefinition, manifest),
    });
  }
  return {
    actions,
    events: new Map(
      manifest.events.map((event) => [event.id, schemaCheck(event.payload)]),
    ),
    entityTypes,
    pieces: {
      app: manifest.id,
      triggers: new Map(
        manifest.provides.triggers.map((trigger) => [
          trigger.id,
          {
            id: trigger.id,
            title: trigger.title,
            event: trigger.event,
            config: schemaCheck(trigger.config),
            schema: trigger.config as JsonSchema,
            words: trigger.words,
            needs: trigger.needs,
          },
        ]),
      ),
      conditions: new Map(manifest.provides.conditions.map(piece)),
      steps: new Map(manifest.provides.steps.map(piece)),
    },
  };
}

const named = z.looseObject({ id: z.string() });
const schema = z.looseObject({});
// What the core reads of a manifest. The rest passes through as it is.
const manifestShape = z.looseObject({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  oldestPage: appManifestSchema.shape.version.optional(),
  pages: z.array(z.string()),
  settings: z
    .looseObject({ properties: z.record(z.string(), schema) })
    .nullable(),
  permissions: z.array(named),
  actions: z.array(
    named.extend({
      title: z.string(),
      tier: tierSchema,
      input: schema,
      output: schema,
    }),
  ),
  events: z.array(named.extend({ payload: schema })),
  provides: z.looseObject({
    entities: z.array(named.extend({ title: z.string(), state: schema })),
    widgets: z.array(named),
    roomSections: z.array(
      named.extend({
        entityType: z.string(),
        order: z.number(),
        press: z.looseObject({ action: z.string() }),
      }),
    ),
    devicePages: z.array(named),
    triggers: z.array(
      named.extend({
        title: z.string(),
        event: z.string(),
        config: schema,
        needs: z.array(z.string()),
      }),
    ),
    conditions: z.array(named.extend({ needs: z.array(z.string()) })),
    steps: z.array(named.extend({ needs: z.array(z.string()) })),
  }),
});

/** A manifest read from a package, before the core uses any of its parts. */
export function checkManifest(manifest: StaticManifest): StaticManifest {
  // A file can say anything: one with parts missing keeps its own package from
  // installing, rather than failing later for every client.
  const shape = manifestShape.safeParse(manifest);
  if (!shape.success) {
    throw new Error(
      `its manifest is incomplete: ${z.prettifyError(shape.error)}`,
    );
  }
  checkPieces(manifest);
  return manifest;
}

// What defineApp checks where the manifest is made that the manifest alone can
// show, since the core reads nothing else of an app: no two of a kind with one
// id, and a room section over a type the app provides in the tile shape, pressed
// with one of its own read or write actions.
function checkPieces(manifest: StaticManifest) {
  const { actions, events, pages, permissions, provides } = manifest;
  const kinds: [string, readonly string[]][] = [
    ["action", actions.map(({ id }) => id)],
    ["event", events.map(({ id }) => id)],
    ["page", pages],
    ["permission", permissions.map(({ id }) => id)],
    ["entity type", provides.entities.map(({ id }) => id)],
    ["widget", provides.widgets.map(({ id }) => id)],
  ];
  for (const [kind, ids] of kinds) {
    const seen = new Set<string>();
    const twice = ids.find((id) => {
      if (seen.has(id)) return true;
      seen.add(id);
      return false;
    });
    if (twice !== undefined) {
      throw new Error(`its manifest has two of its ${kind}s called ${twice}`);
    }
  }
  if (provides.roomSections.length > 1) {
    throw new Error("its manifest has more than one room section");
  }
  for (const section of provides.roomSections) {
    const type = provides.entities.find(({ id }) => id === section.entityType);
    if (!type) {
      throw new Error(
        `its room section ${section.id} shows ${section.entityType}, which it doesn't provide`,
      );
    }
    const problems = tileShapeProblemsOf(type.state);
    if (problems.length > 0) {
      throw new Error(
        `its room section ${section.id} shows ${type.id}, but ${problems.join(", ")}`,
      );
    }
    const press = actions.find(({ id }) => id === section.press.action);
    if (!press || (press.tier !== "read" && press.tier !== "write")) {
      throw new Error(
        `its room section ${section.id} is pressed with ${section.press.action}, which must be one of its read or write actions`,
      );
    }
  }
}

/** Why a value did not pass, as one line for the log. */
export function issuesText(issues: readonly Issue[]) {
  return issues
    .map(({ path, message }) =>
      path.length > 0 ? `${path.join(".")}: ${message}` : message,
    )
    .join("; ");
}

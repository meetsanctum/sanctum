import { z } from "zod";

// An app's settings: its preferences, declared once as a zod object and kept
// by the core. Settings → Apps → the app shows them as a form generated from
// their JSON Schema, which the static manifest carries too, and the app
// reads them with ctx.settings.get(). Each is a plain value the form can
// show: a choice among a few options, a switch, a number or a line of text,
// with a title. An app works before anyone changes its settings, so each has
// a default or may be left out.
//
//   settings: z.object({
//     temperatureUnit: z
//       .enum(["celsius", "fahrenheit"])
//       .default("celsius")
//       .meta({
//         title: "Temperature unit",
//         options: { celsius: "Celsius", fahrenheit: "Fahrenheit" },
//       }),
//   }),

export type SettingValue = string | number | boolean;

/** An app's settings by name, with its schema's defaults (ctx.settings.get()). */
export type AppSettings = Record<string, SettingValue>;

/** One setting, as its JSON Schema describes it to the form. */
export type SettingSchema = {
  type: "string" | "number" | "integer" | "boolean";
  title: string;
  description?: string;
  default?: SettingValue;
  /** A choice's options, each titled in `options`. */
  enum?: string[];
  options?: Record<string, string>;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
};

/** An app's settings schema as JSON Schema, in its manifest and AppInfo. */
export type SettingsSchema = {
  $schema?: string;
  type: "object";
  properties: Record<string, SettingSchema>;
};

const settingName = /^[a-z][a-zA-Z0-9]*$/;
const settingTypes: readonly string[] = [
  "string",
  "number",
  "integer",
  "boolean",
];

/**
 * The JSON Schema of an app's settings, once they are a zod object the
 * form can show. Throws on the first setting it cannot.
 */
export function settingsSchemaOf(settings: unknown): SettingsSchema {
  const schema = settings as z.ZodObject | undefined;
  if (
    typeof schema?.safeParse !== "function" ||
    schema._zod?.def?.type !== "object"
  ) {
    throw new Error("An app's settings are a zod object");
  }
  let json: { properties?: Record<string, Record<string, unknown>> };
  let output: typeof json;
  try {
    // Input-only conversion hides transforms, whose output may no longer
    // be a value the generated field can show or send back; the output
    // must be the same kind of value, checked below.
    output = z.toJSONSchema(schema) as typeof json;
    json = z.toJSONSchema(schema, { io: "input" }) as typeof json;
  } catch {
    throw new Error("An app's settings must have a JSON Schema");
  }
  for (const [name, setting] of Object.entries(json.properties ?? {})) {
    if (!settingName.test(name)) {
      throw new Error(`Setting "${name}" needs a name such as temperatureUnit`);
    }
    if (typeof setting.title !== "string" || !setting.title.trim()) {
      throw new Error(`Setting "${name}" needs a title, from .meta({ title })`);
    }
    if (!settingTypes.includes(setting.type as string)) {
      throw new Error(
        `Setting "${name}" must be a choice, a switch, a number or text`,
      );
    }
    if (output.properties?.[name]?.type !== setting.type) {
      throw new Error(
        `Setting "${name}" must parse to the kind of value it takes`,
      );
    }
    const options = setting.options as Record<string, unknown> | undefined;
    if (Array.isArray(setting.enum)) {
      if (
        setting.type !== "string" ||
        setting.enum.some((option) => typeof option !== "string")
      ) {
        throw new Error(`Setting "${name}" needs string choices`);
      }
      const untitled = setting.enum.filter(
        (option) => typeof options?.[option as string] !== "string",
      );
      if (untitled.length > 0) {
        throw new Error(
          `Setting "${name}" needs a title for ${untitled.join(", ")} in .meta({ options })`,
        );
      }
    } else if (options !== undefined) {
      throw new Error(`Setting "${name}" has options, so it needs a z.enum`);
    }
  }
  let defaults: ReturnType<z.ZodObject["safeParse"]>;
  try {
    defaults = schema.safeParse({});
  } catch {
    throw new Error("An app's settings must parse without throwing");
  }
  if (!defaults.success) {
    throw new Error(
      "Every setting needs a default, or may be left out: the app works before anyone changes it",
    );
  }
  return {
    ...json,
    type: "object",
    properties: (json.properties ?? {}) as Record<string, SettingSchema>,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * An app's settings as it reads them, from what the core keeps: the choices
 * its schema still takes, all together or else each on its own, with its
 * defaults for the rest, and only its defaults if that fails too.
 */
export function settingsAsRead(
  schema: z.ZodObject,
  chosen: unknown,
): AppSettings {
  const declared = Object.entries(isRecord(chosen) ? chosen : {}).filter(
    ([name]) => Object.hasOwn(schema.shape, name),
  );
  const all = Object.fromEntries(declared);
  const fitting = schema.safeParse(all).success
    ? all
    : Object.fromEntries(
        declared.filter(
          ([name, value]) => schema.safeParse({ [name]: value }).success,
        ),
      );
  const parsed = schema.safeParse(fitting);
  return (parsed.success ? parsed.data : schema.parse({})) as AppSettings;
}

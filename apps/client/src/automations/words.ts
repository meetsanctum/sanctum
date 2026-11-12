import {
  stateOperators,
  type PieceInfo,
  type PiecePreset,
  type StateOperator,
  type Weekday,
  type WorkflowNode,
} from "@meetsanctum/app-sdk";
import { pressLabel } from "@meetsanctum/ui-sdk";

// How Automations reads a piece: its sentence or a trigger's card, with a
// token for each field it names, worded from the markers the field's JSON
// Schema carries. The client knows no piece by its id; the sentences,
// presets and schemas all come from the core.

/** One field of a piece's config, as JSON Schema with its markers. */
export type FieldSchema = Record<string, unknown>;

/** What the home calls the things a config names, by their ids. */
export type Names = {
  room(id: string): string | undefined;
  zone(id: string): string | undefined;
  device(id: string): { name: string; kinds: string[] } | undefined;
  entity(type: string, key: string): string | undefined;
  app(id: string): string | undefined;
};

/** A value in a sentence; missing when a required one is not set or gone. */
export type Token = { field: string; text: string; missing: boolean };
export type Part = string | Token;

export type FieldKind =
  | { kind: "names"; names: "room" | "zone" | "device" }
  | { kind: "partOf"; of: string }
  | { kind: "entityOf"; type: string }
  | { kind: "place" }
  | { kind: "timeOfDay" }
  | { kind: "days" }
  | { kind: "offsetMinutes" }
  | { kind: "minutes" }
  | { kind: "lux" }
  | { kind: "choice"; labels: Record<string, string> }
  | { kind: "boolean" }
  | { kind: "number"; minimum?: number; maximum?: number }
  | { kind: "options"; options: string[] }
  | { kind: "text" }
  | { kind: "other" };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A piece's config fields, by name. */
export function fieldsOf(schema: unknown): Record<string, FieldSchema> {
  return isRecord(schema) && isRecord(schema.properties)
    ? (schema.properties as Record<string, FieldSchema>)
    : {};
}

export function requiredOf(schema: unknown): string[] {
  return isRecord(schema) && Array.isArray(schema.required)
    ? (schema.required as string[])
    : [];
}

// How a state's field compares, wherever an operator is worded: "Office
// sensor's value is below 18".
const operatorLabels: Record<StateOperator, string> = {
  equals: "is",
  not_equals: "is not",
  is_on: "is on",
  is_off: "is off",
  below: "is below",
  above: "is above",
};
const isOperators = (values: unknown[]) =>
  values.length > 0 &&
  values.every((value) => stateOperators.includes(value as StateOperator));

/** What a field is, by the marker its schema carries, else by its type. */
export function fieldKind(field: FieldSchema): FieldKind {
  if (
    field.names === "room" ||
    field.names === "zone" ||
    field.names === "device"
  ) {
    return { kind: "names", names: field.names };
  }
  if (typeof field.partOf === "string")
    return { kind: "partOf", of: field.partOf };
  if (typeof field.entityOf === "string") {
    return { kind: "entityOf", type: field.entityOf };
  }
  if (field.place === true) return { kind: "place" };
  if (field.timeOfDay === true) return { kind: "timeOfDay" };
  if (field.days === true) return { kind: "days" };
  if (field.offsetMinutes === true) return { kind: "offsetMinutes" };
  if (field.minutes === true) return { kind: "minutes" };
  if (field.lux === true) return { kind: "lux" };
  if (isRecord(field.labels)) {
    return { kind: "choice", labels: field.labels as Record<string, string> };
  }
  if (field.type === "boolean") return { kind: "boolean" };
  if (field.type === "integer" || field.type === "number") {
    return {
      kind: "number",
      ...(typeof field.minimum === "number" && { minimum: field.minimum }),
      ...(typeof field.maximum === "number" && { maximum: field.maximum }),
    };
  }
  if (Array.isArray(field.enum)) {
    if (isOperators(field.enum)) {
      return {
        kind: "choice",
        labels: Object.fromEntries(
          (field.enum as StateOperator[]).map((value) => [
            value,
            operatorLabels[value],
          ]),
        ),
      };
    }
    return { kind: "options", options: field.enum.map(String) };
  }
  if (field.type === "string") return { kind: "text" };
  return { kind: "other" };
}

export const weekOrder: readonly Weekday[] = [
  "mon",
  "tue",
  "wed",
  "thu",
  "fri",
  "sat",
  "sun",
];
const dayNames: Record<Weekday, [short: string, plural: string]> = {
  mon: ["Mon", "Mondays"],
  tue: ["Tue", "Tuesdays"],
  wed: ["Wed", "Wednesdays"],
  thu: ["Thu", "Thursdays"],
  fri: ["Fri", "Fridays"],
  sat: ["Sat", "Saturdays"],
  sun: ["Sun", "Sundays"],
};
const sameDays = (days: readonly Weekday[], than: readonly Weekday[]) =>
  days.length === than.length && than.every((day) => days.includes(day));
export const weekdaysOnly: readonly Weekday[] = weekOrder.slice(0, 5);
export const weekendsOnly: readonly Weekday[] = weekOrder.slice(5);

export type Style = "sentence" | "card";

/** Days as a sentence reads them (on weekdays) or a card (Weekdays). */
export function formatDays(days: readonly Weekday[] | undefined, style: Style) {
  const sorted = weekOrder.filter((day) => days?.includes(day));
  const words = (() => {
    if (!days || sorted.length === 7) return "every day";
    if (sameDays(sorted, weekdaysOnly)) return "weekdays";
    if (sameDays(sorted, weekendsOnly)) return "weekends";
    if (sorted.length === 1) return dayNames[sorted[0]!][1];
    return sorted.map((day) => dayNames[day][0]).join(", ");
  })();
  if (style === "card") return capitalize(words);
  return words === "every day" ? words : `on ${words}`;
}

/** Minutes before or after a sunrise or sunset. */
export function formatOffset(minutes: number, style: Style) {
  if (minutes === 0) return style === "card" ? "On the dot" : "on the dot";
  const amount = Math.abs(minutes);
  const unit = style === "card" ? "min" : amount === 1 ? "minute" : "minutes";
  return `${amount} ${unit} ${minutes < 0 ? "before" : "after"}`;
}

/** How long something has lasted, as "10 minutes", or "10 min" on a card. */
export function formatMinutes(minutes: number, style: Style) {
  if (style === "card") return `${minutes} min`;
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

const lux = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });

/**
 * A light level someone chose, in lux, as they chose it: "30 lx", "1,500
 * lx". What a sensor reads is ui-sdk's formatLightLevel.
 */
export function formatLux(value: number) {
  return `${lux.format(value)} lx`;
}

export function capitalize(text: string) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** What a field's token reads when it has nothing to show yet. */
export function placeholder(kind: FieldKind) {
  switch (kind.kind) {
    case "names":
      return `Choose a ${kind.names}`;
    case "place":
      return "Choose a room";
    case "entityOf":
      return "Choose one";
    case "timeOfDay":
      return "Choose a time";
    case "minutes":
      return "Choose how long";
    case "lux":
      return "Choose a light level";
    default:
      return "Choose";
  }
}

/** What an optional field left out reads as: any device, any room. */
export function anyOf(kind: FieldKind) {
  switch (kind.kind) {
    case "names":
      return `any ${kind.names}`;
    case "place":
      return "anywhere";
    default:
      return "any";
  }
}

/**
 * A value as its token reads it, or undefined when there is none to show:
 * not set, or naming something the home no longer has.
 */
export function formatValue(
  field: FieldSchema,
  value: unknown,
  names: Names,
  style: Style,
  context: { piece?: Pick<PieceInfo, "app" | "id">; name?: string } = {},
): string | undefined {
  const kind = fieldKind(field);
  if (value === undefined && field.default !== undefined) {
    return formatValue(field, field.default, names, style, context);
  }
  switch (kind.kind) {
    case "names":
      if (typeof value !== "string") return undefined;
      return kind.names === "device"
        ? names.device(value)?.name
        : names[kind.names](value);
    case "place": {
      if (!isRecord(value)) return undefined;
      if (value.kind === "home") return "the whole home";
      if (value.kind === "room" && typeof value.id === "string") {
        return names.room(value.id);
      }
      if (value.kind === "zone" && typeof value.id === "string") {
        return names.zone(value.id);
      }
      // Chosen lights, by their devices' names, while the home has them.
      if (value.kind === "lights" && Array.isArray(value.lights)) {
        const named = value.lights.map((light: unknown) =>
          isRecord(light) && typeof light.device === "string"
            ? names.device(light.device)?.name
            : undefined,
        );
        if (named.length === 0 || named.some((name) => !name)) {
          return undefined;
        }
        return named.length === 1
          ? named[0]
          : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
      }
      return undefined;
    }
    case "entityOf":
      return typeof value === "string"
        ? names.entity(kind.type, value)
        : undefined;
    case "timeOfDay":
      return typeof value === "string" ? value : undefined;
    case "days":
      return formatDays(value as Weekday[] | undefined, style);
    case "offsetMinutes":
      return formatOffset(typeof value === "number" ? value : 0, style);
    case "minutes":
      return typeof value === "number"
        ? formatMinutes(value, style)
        : undefined;
    case "lux":
      return typeof value === "number" ? formatLux(value) : undefined;
    case "choice": {
      const label = typeof value === "string" ? kind.labels[value] : undefined;
      return label && style === "card" ? capitalize(label) : label;
    }
    case "boolean":
      return value === true ? "on" : value === false ? "off" : undefined;
    default:
      break;
  }
  // A remote's press, by the words the driver's action reads as.
  if (
    context.piece?.app === null &&
    context.piece.id === "press" &&
    context.name === "action"
  ) {
    return typeof value === "string" ? pressLabel(value) : "Any press";
  }
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  return undefined;
}

/** A sentence's text and tokens, from its {field} template. */
export function sentenceParts(
  template: string,
  piece: Pick<PieceInfo, "app" | "id" | "config">,
  config: Record<string, unknown>,
  names: Names,
  style: Style = "sentence",
): Part[] {
  const fields = fieldsOf(piece.config);
  const required = requiredOf(piece.config);
  const parts: Part[] = [];
  let rest = template;
  for (const match of template.matchAll(/\{(\w+)\}/g)) {
    const [whole, name] = match;
    const at = rest.indexOf(whole);
    if (at > 0) parts.push(rest.slice(0, at));
    rest = rest.slice(at + whole.length);
    const field = fields[name!] ?? {};
    const text = formatValue(field, config[name!], names, style, {
      piece,
      name,
    });
    // An optional field left out means any; one that is set but names
    // what is gone, or a required one not set yet, is missing.
    parts.push(
      text !== undefined
        ? { field: name!, text, missing: false }
        : config[name!] === undefined && !required.includes(name!)
          ? { field: name!, text: anyOf(fieldKind(field)), missing: false }
          : {
              field: name!,
              text: placeholder(fieldKind(field)),
              missing: true,
            },
    );
  }
  if (rest) parts.push(rest);
  // A sentence that starts with a value starts with a capital: "The whole
  // home is darker than 30 lx".
  const [first] = parts;
  if (first !== undefined && typeof first !== "string") {
    parts[0] = { ...first, text: capitalize(first.text) };
  }
  return parts;
}

/** The parts as one line of text, for labels and screen readers. */
export function plain(parts: Part[]) {
  return parts
    .map((part) => (typeof part === "string" ? part : part.text))
    .join("");
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((each, at) => sameValue(each, b[at]))
    );
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((key) => sameValue(a[key], b[key]))
    );
  }
  return false;
}

/** The preset a config is an instance of: the one fixing most of it. */
export function presetOf(
  piece: Pick<PieceInfo, "presets">,
  config: Record<string, unknown>,
): PiecePreset | undefined {
  return piece.presets
    .filter((preset) =>
      Object.entries(preset.config).every(([key, value]) =>
        sameValue(config[key], value),
      ),
    )
    .sort(
      (a, b) => Object.keys(b.config).length - Object.keys(a.config).length,
    )[0];
}

/**
 * How a node reads: its preset's sentence, else its piece's, else the
 * piece's title and the values that are set.
 */
export function nodeParts(
  piece: PieceInfo,
  node: Pick<WorkflowNode, "config">,
  names: Names,
): Part[] {
  const template = presetOf(piece, node.config)?.sentence ?? piece.sentence;
  if (template) return sentenceParts(template, piece, node.config, names);
  const fields = fieldsOf(piece.config);
  const values = Object.entries(node.config).flatMap(([name, value]) => {
    const kind = fieldKind(fields[name] ?? {});
    if (kind.kind === "partOf") return [];
    const text = formatValue(fields[name] ?? {}, value, names, "sentence", {
      piece,
      name,
    });
    return text === undefined ? [] : [{ field: name, text, missing: false }];
  });
  return values.length === 0
    ? [piece.title]
    : [
        `${piece.title}: `,
        ...values.flatMap((token, at) => (at === 0 ? [token] : [", ", token])),
      ];
}

/** A trigger's card in the list: a name and specifics. */
export function cardOf(
  piece: PieceInfo,
  node: Pick<WorkflowNode, "config">,
  names: Names,
): { name: string; specifics: string | null } {
  const preset = presetOf(piece, node.config);
  const card = preset?.card ?? piece.card;
  if (!card) return { name: piece.title, specifics: null };
  const read = (template: string) =>
    capitalize(
      plain(sentenceParts(template, piece, node.config, names, "card")),
    );
  return {
    name: read(card.name),
    specifics: card.specifics ? read(card.specifics) : null,
  };
}

// The list's groups, in their order: the core's named groups first, then a
// device's by its category as the sidebar names them, then each app's by
// its name, and By hand last. A motion sensor's device trigger joins the
// core's Motion.
const firstGroups = ["Time", "Sunrise and sunset", "Motion"];
const categories: Record<string, string> = {
  light: "Lights",
  switch: "Switches",
  sensor: "Environment",
  occupancy: "Motion",
  button: "Buttons",
};
const lastGroup = "By hand";

/** The group a trigger's workflow is listed under. */
export function groupOf(
  piece: PieceInfo,
  node: Pick<WorkflowNode, "config">,
  names: Names,
): string {
  if (piece.group) return piece.group;
  if (piece.app) return names.app(piece.app) ?? piece.app;
  const kind =
    (typeof node.config.kind === "string" && node.config.kind) ||
    (typeof node.config.device === "string" &&
      names.device(node.config.device)?.kinds[0]);
  return (kind && categories[kind]) || "Devices";
}

/** Sorts group names into the list's order. */
export function compareGroups(a: string, b: string) {
  const rank = (group: string) => {
    const first = firstGroups.indexOf(group);
    if (first >= 0) return first;
    if (group === lastGroup) return firstGroups.length + 2;
    return Object.values(categories).includes(group) || group === "Devices"
      ? firstGroups.length
      : firstGroups.length + 1;
  };
  return rank(a) - rank(b) || a.localeCompare(b);
}

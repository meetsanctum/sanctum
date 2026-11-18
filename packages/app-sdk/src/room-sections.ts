import { z } from "zod";

import type { ActionDefinition, AppDefinition } from "./index.js";

// Room sections: what an app adds to a room's row, the tiles under the
// room's name on its page and on Home that switch its lights and set their
// look. The shell draws each from the app's entities of one type in that
// room, after the room's own switch: first every section's buttons, square
// tiles with only their icon, such as Natural light's sun, then every
// section's tiles with their names, such as Moods' moods. The row has no
// headings. No app code runs to draw it, so a section looks native whoever
// brings it.

/**
 * How a section shows in the room's row: as buttons, square tiles with
 * only their icon, which say their name to a screen reader and on hover,
 * or as tiles with their icon and name.
 */
export const roomSectionKinds = ["tiles", "buttons"] as const;
export type RoomSectionKind = (typeof roomSectionKinds)[number];

/**
 * The icons a section's tiles may have, as Lucide names them. The shell
 * draws each (ui-sdk's tileIconOf), so a tile shows only these.
 */
export const tileIcons = [
  "sparkles",
  "armchair",
  "baby",
  "bath",
  "bed",
  "book-open",
  "briefcase",
  "cloud-moon",
  "coffee",
  "dumbbell",
  "film",
  "flame",
  "flower",
  "gamepad-2",
  "heart",
  "house",
  "moon",
  "music",
  "palette",
  "party-popper",
  "play",
  "star",
  "sun",
  "sunrise",
  "sunset",
  "trees",
  "utensils",
  "waves",
  "wine",
  "zap",
] as const;
export type TileIcon = (typeof tileIcons)[number];

/**
 * The tile shape: what the state of every entity a room section shows
 * holds, besides anything else its type keeps, whether the section shows
 * it as a tile or a button. The core checks a section's type against it
 * when the app is installed, and each state when the app publishes it.
 */
export const roomSectionTile = z.object({
  /** The room it is in. */
  placeId: z.string(),
  icon: z.enum(tileIcons),
  name: z.string(),
  /** Its place among the section's tiles or buttons in the room, from 0. */
  order: z.number().int().min(0),
  /** Whether it is active now, which the shell shows White, and pressed. */
  active: z.boolean(),
  /** What the section's action takes when the tile is tapped, such as { id }. */
  input: z.record(z.string(), z.unknown()),
});
export type RoomSectionTile = z.infer<typeof roomSectionTile>;

/**
 * A sample tile, which the app's settings page shows as its section would:
 * an icon, a name and whether it is active.
 */
export const sampleTile = z.strictObject({
  icon: z.enum(tileIcons),
  name: z.string().trim().min(1).max(40),
  active: z.boolean(),
});
export type SampleTile = z.infer<typeof sampleTile>;

/** A preview shows a few tiles, as a room would. */
export const sampleTilesMax = 6;

/**
 * Where a room's sections go in its row, buttons and tiles each by these
 * weights. Sanctum keeps those below `appSectionOrderFrom` for its own, such
 * as 200 for Moods and Natural light; any app takes one from 300 to 799, 500
 * unless it says, and ties go by app id.
 */
export const sectionOrderFrom = 100;
export const appSectionOrderFrom = 300;
export const sectionOrderTo = 799;
export const defaultSectionOrder = 500;

export interface RoomSectionDefinition {
  /** Namespaced, such as moods.room: part of the app's contract, like a widget's id. */
  readonly id: string;
  /** What it is, such as Moods: the app's settings and a screen reader say it. */
  readonly title: string;
  /** One of the types the app provides, whose state has the tile shape. */
  readonly entityType: string;
  /** Buttons with only their icon, or tiles with their names. */
  readonly kind: RoomSectionKind;
  /**
   * Its weight among the room's sections, from 300 to 799, 500 when it
   * says none; below 300 only for Sanctum's own apps.
   */
  readonly order?: number;
  /**
   * One of the app's own actions, read or write, which a tap calls with
   * the tile's input, through the gate. It may answer `failed`, the lights
   * and switches it could not reach, which the shell shows on their tiles.
   */
  readonly press: ActionDefinition;
  /**
   * Sample tiles or buttons for its preview on the app's settings page,
   * such as Moods' Aurora and Evening, one of them active.
   */
  readonly preview?: readonly SampleTile[];
}

export function defineRoomSection(
  section: RoomSectionDefinition,
): RoomSectionDefinition {
  return section;
}

/** A room section as clients see it (GET /api/apps). */
export type RoomSectionInfo = {
  id: string;
  title: string;
  entityType: string;
  kind: RoomSectionKind;
  /** Its weight among the room's sections of its kind. */
  order: number;
  /** The action a tap calls. */
  press: { action: string };
};

export function roomSectionInfo(
  section: RoomSectionDefinition,
): RoomSectionInfo {
  return {
    id: section.id,
    title: section.title,
    entityType: section.entityType,
    kind: section.kind,
    order: section.order ?? defaultSectionOrder,
    press: { action: section.press.id },
  };
}

const memberId = /^[a-z][a-zA-Z0-9]*(\.[a-z][a-zA-Z0-9]*)+$/;

type JsonSchema = {
  type?: unknown;
  enum?: unknown[];
  const?: unknown;
  minimum?: number;
  properties?: Record<string, JsonSchema>;
  required?: string[];
};

// Whether one field of a state's JSON Schema fits the tile shape's.
const fits: Record<keyof RoomSectionTile, (field: JsonSchema) => boolean> = {
  placeId: (field) => field.type === "string",
  icon: (field) => {
    const values = field.enum ?? ("const" in field ? [field.const] : null);
    return (
      values !== null &&
      values.every((value) => tileIcons.includes(value as TileIcon))
    );
  },
  name: (field) => field.type === "string",
  order: (field) =>
    field.type === "integer" &&
    field.minimum !== undefined &&
    field.minimum >= 0,
  active: (field) => field.type === "boolean",
  input: (field) => field.type === "object",
};

/** What keeps a state schema from having the tile shape, if anything. */
export function tileShapeProblems(state: z.ZodType): string[] {
  let json: unknown;
  try {
    json = z.toJSONSchema(state, { io: "output" });
  } catch {
    return ["its state has no JSON Schema"];
  }
  return tileShapeProblemsOf(json);
}

/**
 * The same, for a state's JSON Schema as a manifest holds it, so the core can
 * check what it reads there.
 */
export function tileShapeProblemsOf(schema: unknown): string[] {
  const json = (schema ?? {}) as JsonSchema;
  if (json.type !== "object") {
    return ["its state is not an object"];
  }
  return (Object.keys(fits) as (keyof RoomSectionTile)[]).flatMap((name) => {
    const field = json.properties?.[name];
    if (!field || !json.required?.includes(name)) {
      return [`its state needs ${name}`];
    }
    return fits[name](field) ? [] : [`its ${name} does not fit a tile`];
  });
}

/**
 * An app's room sections: at most one, of tiles or buttons, over a type it
 * provides in the tile shape, pressed with one of its own read or write
 * actions.
 */
export function assertRoomSections(app: AppDefinition) {
  const sections = app.provides?.roomSections ?? [];
  if (!Array.isArray(sections)) {
    throw new Error("An app's room sections must be a list");
  }
  if (sections.length > 1) {
    throw new Error("An app has one room section at most");
  }
  const types = app.provides?.entities ?? [];
  for (const section of sections) {
    const id = String(section?.id);
    if (!memberId.test(id)) {
      throw new Error(
        `Room section "${id}" needs a namespaced id, such as moods.room`,
      );
    }
    if (typeof section.title !== "string" || !section.title.trim()) {
      throw new Error(`Room section "${id}" needs a title`);
    }
    if (!roomSectionKinds.includes(section.kind)) {
      throw new Error(
        `Room section "${id}" is of the kind ${roomSectionKinds.join(" or ")}`,
      );
    }
    if (
      section.order !== undefined &&
      (!Number.isInteger(section.order) ||
        section.order < sectionOrderFrom ||
        section.order > sectionOrderTo)
    ) {
      throw new Error(
        `Room section "${id}" takes an order from ${appSectionOrderFrom} to ${sectionOrderTo}`,
      );
    }
    const type = types.find((each) => each.id === section.entityType);
    if (!type) {
      throw new Error(
        `Room section "${id}" shows ${String(section.entityType)}, which the app does not provide`,
      );
    }
    const problems = tileShapeProblems(type.state);
    if (problems.length > 0) {
      throw new Error(
        `Room section "${id}" shows ${type.id}, but ${problems.join(", ")}`,
      );
    }
    if (!app.actions.includes(section.press)) {
      throw new Error(
        `Room section "${id}" is pressed with an action that is not one of the app's`,
      );
    }
    if (section.press.tier !== "read" && section.press.tier !== "write") {
      throw new Error(
        `Room section "${id}" is pressed with ${section.press.id}, which must be read or write`,
      );
    }
    const { preview } = section;
    if (
      preview !== undefined &&
      (!Array.isArray(preview) ||
        preview.length === 0 ||
        preview.length > sampleTilesMax ||
        [...preview].some((tile) => !sampleTile.safeParse(tile).success))
    ) {
      throw new Error(
        `Room section "${id}" previews 1 to ${sampleTilesMax} sample tiles, each with an icon, a name and whether it is active`,
      );
    }
  }
}

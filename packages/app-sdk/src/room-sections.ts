import { z } from "zod";

import { capabilityKinds, type CapabilityKind } from "./devices.js";
import type { ActionDefinition, AppDefinition } from "./index.js";
import { permissionIds } from "./permissions.js";

// Room sections: what an app adds to every room's page, which the shell
// draws with its own tiles under a neutral heading, from the app's entities
// of one type in that room. No app code runs to draw it, so a section looks
// native whoever brings it.

/**
 * The icons a section's tiles may have, as Lucide names them: v1's mood
 * icons, with Lucide's own names for v1's home, work and gamepad. The shell
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
 * holds, besides anything else its type keeps. The core checks a section's
 * type against it when the app is installed, and each state when the app
 * publishes it.
 */
export const roomSectionTile = z.object({
  /** The room it is in. */
  placeId: z.string(),
  icon: z.enum(tileIcons),
  name: z.string(),
  /** Its place among the room's tiles, from 0. */
  order: z.number().int().min(0),
  /** Whether it is active now, which the shell shows White. */
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
 * Where a room's sections go: after the room's header, by these weights, and
 * before its devices. Sanctum keeps those below `appSectionOrderFrom` for
 * its own, such as 200 for Moods; any app takes one from 300 to 799, 500
 * unless it says, and ties go by app id.
 */
export const sectionOrderFrom = 100;
export const appSectionOrderFrom = 300;
export const sectionOrderTo = 799;
export const defaultSectionOrder = 500;

export interface RoomSectionDefinition {
  /** Namespaced, such as moods.room: part of the app's contract, like a widget's id. */
  readonly id: string;
  /** Its heading, such as Moods. */
  readonly title: string;
  /** One of the types the app provides, whose state has the tile shape. */
  readonly entityType: string;
  /** Tiles are the only kind. */
  readonly kind: "tiles";
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
   * A page of the app that a link beside the heading opens, with
   * `{ placeId }`, such as Moods' page for the room.
   */
  readonly open?: { readonly page: string; readonly label: string };
  /**
   * When a room has nothing for the section, it still shows its heading
   * and `open` if the room has a device of this kind, so someone can add
   * the first. Otherwise a room with nothing has no
   * section.
   */
  readonly whenEmpty?: { readonly roomHas: CapabilityKind };
  /**
   * Sample tiles for its preview on the app's settings page, such as
   * Moods' Aurora and Evening, one of them active.
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
  kind: "tiles";
  /** Its weight among the room's sections. */
  order: number;
  /** The action a tap calls. */
  press: { action: string };
  open: { page: string; label: string } | null;
  whenEmpty: { roomHas: CapabilityKind } | null;
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
    open: section.open ? { ...section.open } : null,
    whenEmpty: section.whenEmpty ? { ...section.whenEmpty } : null,
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
 * An app's room sections: at most one, of the kind tiles, over a type it
 * provides in the tile shape, pressed with one of its own read or write
 * actions, opening one of its pages, and shown empty only for a kind of
 * device it reads.
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
  const pages = app.pages ?? [];
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
    if (section.kind !== "tiles") {
      throw new Error(`Room section "${id}" is of the kind tiles`);
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
    const { open, whenEmpty, preview } = section;
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
    if (
      open !== undefined &&
      (!pages.includes(open?.page) ||
        typeof open.label !== "string" ||
        !open.label.trim())
    ) {
      throw new Error(
        `Room section "${id}" opens one of the app's pages, with a label`,
      );
    }
    if (whenEmpty !== undefined) {
      const kind = whenEmpty?.roomHas;
      if (!capabilityKinds.includes(kind)) {
        throw new Error(
          `Room section "${id}" is shown empty for a kind of device: ${capabilityKinds.join(", ")}`,
        );
      }
      const asked = permissionIds(app.permissions);
      if (
        !asked.includes(`devices.read:${kind}`) &&
        !asked.includes(`devices.control:${kind}`)
      ) {
        throw new Error(
          `Room section "${id}" is shown empty for rooms with a ${kind}, which the app does not read`,
        );
      }
      if (!open) {
        throw new Error(
          `Room section "${id}" is shown empty only to offer what it opens`,
        );
      }
    }
  }
}

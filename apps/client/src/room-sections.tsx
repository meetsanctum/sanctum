import {
  roomSectionTile,
  type AppInfo,
  type EntityInfo,
  type RoomSectionInfo,
  type RoomSectionKind,
  type RoomSectionTile,
} from "@meetsanctum/app-sdk";
import {
  icons,
  SectionTile,
  tileIconOf,
  type LiveFeed,
} from "@meetsanctum/ui-sdk";
import { useCallback, useState, type ReactNode } from "react";

import { entityKey, shownType, useAppEntities } from "./app-entities";
import { isShown, looksRunning, stateShort } from "./app-state";
import { coreJson } from "./core-fetch";
import { tileKey } from "./device-tiles";
import type { LightsSwitch } from "./lights-button";

// Apps' room sections: the shell draws each from the app's entities of the
// section's type in the room, in the room's row (RoomRow) after its switch,
// buttons as squares with their icon alone and tiles with their names. No
// app code runs to draw one. A tap calls the section's action through the
// gate; the lights and switches it could not reach fail on their tiles, and
// a tap that fails as a whole fails on the section's own tile. While the
// app isn't running its tiles dim and say so. What a room has is the
// household's, a shared tablet's too, and an app's own page is where its
// tiles are made and changed.

/** One of an app's section tiles, as its entity says. */
export type SectionEntity = {
  app: string;
  type: string;
  key: string;
  tile: RoomSectionTile;
};

// A tile, if the entity has the tile shape.
function sectionEntity(entity: EntityInfo): SectionEntity | null {
  const tile = roomSectionTile.safeParse(entity.state);
  return tile.success
    ? { app: entity.app, type: entity.type, key: entity.key, tile: tile.data }
    : null;
}

/** An installed app's room section. */
type AppSection = { app: AppInfo; section: RoomSectionInfo };

/**
 * A room's sections of one kind in their order: by the weight each
 * declares, Sanctum's own first (Moods and Natural light at 200), then other
 * apps' from 300, ties by app id.
 */
function sectionsInOrder(
  apps: readonly AppInfo[],
  kind: RoomSectionKind,
): AppSection[] {
  return apps
    .filter(isShown)
    .flatMap((app) =>
      app.provides.roomSections
        .filter((section) => section.kind === kind)
        .map((section) => ({ app, section })),
    )
    .sort(
      (a, b) =>
        a.section.order - b.section.order || a.app.id.localeCompare(b.app.id),
    );
}

/**
 * The entities every installed app's room sections show, as tiles (see
 * app-entities.ts). Taps that failed are counted by tile.
 */
export function useSectionEntities(
  live: LiveFeed,
  apps: readonly AppInfo[],
  failDevices: (keys: string[]) => void,
) {
  const entities = useAppEntities(
    live,
    apps.flatMap((app) =>
      app.provides.roomSections.map((section) =>
        shownType(app.id, section.entityType),
      ),
    ),
    sectionEntity,
  );
  const [failures, setFailures] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );

  // Calls the section's action with the tile's input, through the gate.
  const press = useCallback(
    async (app: string, section: RoomSectionInfo, entity: SectionEntity) => {
      const key = entityKey(entity.app, entity.key);
      try {
        const output = await coreJson<unknown>(
          `/api/apps/${encodeURIComponent(app)}/actions/${encodeURIComponent(section.press.action)}`,
          { method: "POST", json: entity.tile.input },
        );
        failDevices(failedDevices(output));
      } catch {
        setFailures((current) =>
          new Map(current).set(key, (current.get(key) ?? 0) + 1),
        );
      }
    },
    [failDevices],
  );

  // A room's tiles of one app's section, in their order.
  const tilesIn = useCallback(
    (app: string, section: RoomSectionInfo, roomId: string) =>
      [...entities.values()]
        .filter(
          (entity) =>
            entity.app === app &&
            entity.type === section.entityType &&
            entity.tile.placeId === roomId,
        )
        .sort(
          (a, b) =>
            a.tile.order - b.tile.order ||
            a.tile.name.localeCompare(b.tile.name),
        ),
    [entities],
  );

  return {
    tilesIn,
    press,
    failuresOf: (entity: SectionEntity) =>
      failures.get(entityKey(entity.app, entity.key)),
  };
}

export type SectionEntities = ReturnType<typeof useSectionEntities>;

// The lights and switches a press could not reach, if its answer names them
// as `failed`.
function failedDevices(output: unknown): string[] {
  const failed = (output as { failed?: unknown } | null)?.failed;
  if (!Array.isArray(failed)) return [];
  return failed.flatMap((each: { device?: unknown; capability?: unknown }) =>
    typeof each?.device === "string" && typeof each.capability === "string"
      ? [tileKey(each.device, each.capability)]
      : [],
  );
}

/** One of a room's buttons or tiles, from an app's room section. */
type RowEntry = AppSection & { entity: SectionEntity };

/** A room's row: its switch, then apps' buttons, then apps' tiles. */
type RoomRowParts = {
  lights?: LightsSwitch;
  buttons: RowEntry[];
  tiles: RowEntry[];
};

/** What these sections show in a room, in their order. */
function entriesIn(
  sections: readonly AppSection[],
  entities: SectionEntities,
  roomId: string,
): RowEntry[] {
  return sections.flatMap(({ app, section }) =>
    entities
      .tilesIn(app.id, section, roomId)
      .map((entity) => ({ app, section, entity })),
  );
}

/** A room's row as its lights and apps' sections stand, maybe empty. */
export function roomRowOf(
  apps: readonly AppInfo[],
  entities: SectionEntities,
  roomId: string,
  lights: LightsSwitch | undefined,
): RoomRowParts {
  return {
    lights,
    buttons: entriesIn(sectionsInOrder(apps, "buttons"), entities, roomId),
    tiles: entriesIn(sectionsInOrder(apps, "tiles"), entities, roomId),
  };
}

export const isRowEmpty = (row: RoomRowParts) =>
  !row.lights && row.buttons.length === 0 && row.tiles.length === 0;

/**
 * A room's row, under its name on its page and on Home: its switch, a square
 * tile with the power symbol that says what it does ("Turn off 3 lights in
 * Kitchen") and is White while any light is on, then apps' buttons, square
 * with their icon alone, then apps' tiles with their names. The switch says
 * whether the lights are on, the rest which look they have, so at most one
 * of those is lit: Natural light before a mood that matches the curve, and
 * a running app's look before the last one a paused app said. Each is named
 * with the room, since several rooms' are in reach on Home. While every
 * light is offline the core can reach none, so the whole row dims; while an
 * app isn't running its own buttons and tiles dim and say so.
 */
export function RoomRow(props: {
  row: RoomRowParts;
  roomName: string;
  entities: SectionEntities;
}) {
  const { row, roomName, entities } = props;
  const dark = row.lights?.disabled === true;
  const active = [...row.buttons, ...row.tiles].filter(
    ({ entity }) => entity.tile.active,
  );
  const lit = active.find(({ app }) => looksRunning(app)) ?? active[0];
  const tileOf = ({ app, section, entity }: RowEntry, iconOnly: boolean) => {
    const notRunning = stateShort(app);
    const label = `${entity.tile.name} in ${roomName}`;
    return (
      <SectionTile
        key={entityKey(entity.app, entity.key)}
        iconOnly={iconOnly}
        icon={tileIconOf[entity.tile.icon]}
        name={entity.tile.name}
        label={notRunning ? `${label}, ${notRunning.toLowerCase()}` : label}
        status={iconOnly ? undefined : (notRunning ?? undefined)}
        active={lit?.entity === entity}
        disabled={notRunning !== null || dark}
        failures={entities.failuresOf(entity)}
        onClick={() => void entities.press(app.id, section, entity)}
      />
    );
  };
  const squares = (row.lights ? 1 : 0) + row.buttons.length;
  return (
    <div
      role="group"
      aria-label={`Lights in ${roomName}`}
      className="tile-grid auto-rows-(--cell)"
    >
      {squares > 0 && (
        <RowSquares count={squares}>
          {row.lights && <RoomSwitch lights={row.lights} />}
          {row.buttons.map((each) => tileOf(each, true))}
        </RowSquares>
      )}
      {row.tiles.map((each) => tileOf(each, false))}
    </div>
  );
}

/**
 * A room's switch for all its lights, a square with the power symbol that is
 * White while any light is on: first in its row, and first in its lights on
 * Lights' page.
 */
export function RoomSwitch(props: { lights: LightsSwitch }) {
  const { lights } = props;
  return (
    <SectionTile
      iconOnly
      icon={icons.Power}
      name={lights.label}
      lit={lights.on > 0}
      disabled={lights.disabled}
      onClick={lights.onToggle}
    />
  );
}

/**
 * A row's squares, in a tile grid: a cell each, and on a phone, whose grid
 * is six columns, the first half of the row's first line between them, two
 * to a line, so they line up with the tiles below.
 */
export function RowSquares(props: { count: number; children: ReactNode }) {
  return (
    <div
      className="contents max-sm:col-span-3 max-sm:grid max-sm:auto-rows-(--cell) max-sm:grid-cols-2 max-sm:gap-(--cell-gap)"
      style={{ gridRow: `span ${Math.ceil(props.count / 2)}` }}
    >
      {props.children}
    </div>
  );
}

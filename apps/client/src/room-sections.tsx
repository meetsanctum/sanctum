import {
  roomSectionTile,
  type AppInfo,
  type EntityInfo,
  type RoomSectionInfo,
  type RoomSectionKind,
  type RoomSectionTile,
} from "@meetsanctum/app-sdk";
import {
  SectionButton,
  SectionTile,
  tileIconOf,
  type LiveFeed,
} from "@meetsanctum/ui-sdk";
import { useCallback, useMemo, useState } from "react";

import { entityKey, shownType, useAppEntities } from "./app-entities";
import { isShown, looksRunning, stateShort } from "./app-state";
import { coreJson } from "./core-fetch";
import { tileKey } from "./device-tiles";
import { LightsButton, type LightsButtonState } from "./lights-button";
import { sameData } from "./same-data";

// Apps' room sections: the shell draws each from the app's entities of the
// section's type in the room, in the room's row (RoomRow): buttons as chips
// beside its lights button and tiles with their names under them. No app
// code runs to draw one. A tap calls the section's action through the
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
 * declares, Sanctum's own first (Moods and Natural Light at 200), then other
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

  const failuresOf = useCallback(
    (entity: SectionEntity) => failures.get(entityKey(entity.app, entity.key)),
    [failures],
  );
  return useMemo(
    () => ({ tilesIn, press, failuresOf }),
    [tilesIn, press, failuresOf],
  );
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
type RowEntry = AppSection & {
  entity: SectionEntity;
  failures: number | undefined;
};

/** A room's row: its lights button, then apps' buttons, then apps' tiles. */
type RoomRowParts = {
  lights?: LightsButtonState;
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
    entities.tilesIn(app.id, section, roomId).map((entity) => ({
      app,
      section,
      entity,
      failures: entities.failuresOf(entity),
    })),
  );
}

/** A room's row as its lights and apps' sections stand, maybe empty. */
export function roomRowOf(
  apps: readonly AppInfo[],
  entities: SectionEntities,
  roomId: string,
  lights: LightsButtonState | undefined,
): RoomRowParts {
  return {
    lights,
    buttons: entriesIn(sectionsInOrder(apps, "buttons"), entities, roomId),
    tiles: entriesIn(sectionsInOrder(apps, "tiles"), entities, roomId),
  };
}

export const isRowEmpty = (row: RoomRowParts) =>
  !row.lights && row.buttons.length === 0 && row.tiles.length === 0;

function sameEntries(before: readonly RowEntry[], after: readonly RowEntry[]) {
  return (
    before.length === after.length &&
    before.every(({ app, section, entity, failures }, index) => {
      const next = after[index]!;
      return (
        app === next.app &&
        section === next.section &&
        entity === next.entity &&
        failures === next.failures
      );
    })
  );
}

export function sameRoomRow(
  before: RoomRowParts | null,
  after: RoomRowParts | null,
) {
  if (before === after) return true;
  return (
    before !== null &&
    after !== null &&
    sameData(before.lights, after.lights, { functionsAlike: true }) &&
    sameEntries(before.buttons, after.buttons) &&
    sameEntries(before.tiles, after.tiles)
  );
}

/**
 * A room's row, under its name on its page and on Home: on its first line
 * its lights button, a chip that says what it does ("Turn off lights") and
 * is White while any light is on (lights-button.tsx), and apps' buttons,
 * chips with their icon and name, such as Natural Light; then apps' tiles
 * with their names, such as the room's moods. The lights button says
 * whether the lights are on, the rest which look they have. At most one
 * look is lit: Natural Light before a mood that matches the curve, and a
 * running app's look before the last one a paused app said.
 * Each is named with the room, since several rooms' are in reach on Home.
 * While every light is offline the core can reach none, so the whole row
 * dims; while an app isn't running its own buttons and tiles dim and say so.
 */
export function RoomRow(props: {
  row: RoomRowParts;
  roomName: string;
  press: SectionEntities["press"];
}) {
  const { row, roomName, press } = props;
  const dark = row.lights?.isDisabled === true;
  const active = [...row.buttons, ...row.tiles].filter(
    ({ entity }) => entity.tile.active,
  );
  const lit = active.find(({ app }) => looksRunning(app)) ?? active[0];
  const entryOf = ({ app, section, entity, failures }: RowEntry) => {
    const notRunning = stateShort(app);
    const label = `${entity.tile.name} in ${roomName}`;
    const shared = {
      icon: tileIconOf[entity.tile.icon],
      name: entity.tile.name,
      label: notRunning ? `${label}, ${notRunning.toLowerCase()}` : label,
      active: lit?.entity === entity,
      disabled: notRunning !== null || dark,
      failures,
      onClick: () => void press(app.id, section, entity),
    };
    const key = entityKey(entity.app, entity.key);
    // Buttons are chips beside the lights button, tiles tiles under them.
    return section.kind === "buttons" ? (
      <SectionButton key={key} {...shared} />
    ) : (
      <SectionTile key={key} {...shared} status={notRunning ?? undefined} />
    );
  };
  const hasChips = row.lights !== undefined || row.buttons.length > 0;
  return (
    <div
      role="group"
      aria-label={`Lights in ${roomName}`}
      className="flex flex-col gap-3"
    >
      {hasChips && (
        <div className="flex flex-wrap gap-2">
          {row.lights && <LightsButton lights={row.lights} />}
          {row.buttons.map(entryOf)}
        </div>
      )}
      {row.tiles.length > 0 && (
        <div className="tile-grid auto-rows-(--cell)">
          {row.tiles.map(entryOf)}
        </div>
      )}
    </div>
  );
}

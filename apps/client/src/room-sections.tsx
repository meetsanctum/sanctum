import {
  roomSectionTile,
  type AppInfo,
  type CapabilityKind,
  type EntityInfo,
  type RoomSectionInfo,
  type RoomSectionTile,
} from "@meetsanctum/app-sdk";
import {
  Button,
  SectionHeading,
  SectionTile,
  tileIconOf,
  type LiveFeed,
} from "@meetsanctum/ui-sdk";
import { useCallback, useState } from "react";

import { entityKey, shownType, useAppEntities } from "./app-entities";
import { isShown, stateShort } from "./app-state";
import { coreJson } from "./core-fetch";
import { tileKey } from "./device-tiles";

// Apps' room sections: the shell draws each from the app's entities of the
// section's type in the room, as tiles, under a heading that looks like its
// own sections'. No app code runs to draw one. A tap calls the section's
// action through the gate; the lights and switches it could not reach fail
// on their tiles, and a tap that fails as a whole fails on the section's
// tile. While the app isn't running its tiles dim and say so. Edit beside
// the heading opens the app's page for the room, on every device: what a
// room has is the household's, a shared tablet's too.

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
export type AppSection = { app: AppInfo; section: RoomSectionInfo };

/**
 * A room's sections in their order: by the weight each declares, Sanctum's
 * own first (Moods at 200), then other apps' from 300, ties by app id. The
 * device sections follow them.
 */
export function sectionsInOrder(apps: readonly AppInfo[]): AppSection[] {
  return apps
    .filter(isShown)
    .flatMap((app) =>
      app.provides.roomSections.map((section) => ({ app, section })),
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

/**
 * One app's section in a room, or nothing for a room it has nothing for,
 * unless its empty rule keeps its heading and link. On Home it is only its
 * tiles, under the room's name (home-dashboard.tsx).
 */
export function RoomSection(props: {
  app: AppInfo;
  section: RoomSectionInfo;
  roomId: string;
  entities: SectionEntities;
  /** Whether the room has a device of each kind, for the empty rule. */
  roomHas: (kind: CapabilityKind) => boolean;
  /** Opens the app's page for the room, if the shell has it. */
  onOpen?: () => void;
  /** Only its tiles, named for the section, and nothing while it has none. */
  bare?: boolean;
}) {
  const { app, section, roomId, entities } = props;
  const tiles = entities.tilesIn(app.id, section, roomId);
  // While the app isn't running its tiles keep their last state, dimmed,
  // and say why, since the core would refuse a tap.
  const notRunning = stateShort(app);
  const link = section.open && props.onOpen ? section.open : null;
  const showsEmpty =
    !props.bare &&
    link !== null &&
    section.whenEmpty !== null &&
    props.roomHas(section.whenEmpty.roomHas);
  if (tiles.length === 0 && !showsEmpty) return null;
  const headingId = `section-${app.id}-${roomId}`;
  const grid = (
    <div
      role={props.bare ? "group" : undefined}
      aria-label={props.bare ? section.title : undefined}
      className="grid auto-rows-(--cell) grid-cols-[repeat(auto-fill,var(--cell))] gap-(--cell-gap)"
    >
      {tiles.map((entity) => (
        <SectionTile
          key={entity.key}
          icon={tileIconOf[entity.tile.icon]}
          name={entity.tile.name}
          active={entity.tile.active}
          status={notRunning ?? undefined}
          disabled={notRunning !== null}
          failures={entities.failuresOf(entity)}
          onClick={() => void entities.press(app.id, section, entity)}
        />
      ))}
    </div>
  );
  if (props.bare) return grid;
  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      {/* The link keeps to the heading's line, so the heading sits as the
          device sections' do. */}
      <div className="flex items-center gap-3">
        <SectionHeading id={headingId}>{section.title}</SectionHeading>
        {link && (
          <Button variant="link" size="label" onClick={props.onOpen}>
            {link.label}
          </Button>
        )}
      </div>
      {tiles.length > 0 && grid}
    </section>
  );
}

import type { AppInfo } from "@meetsanctum/app-sdk";
import { Button, DeviceTile, icons, type Tile } from "@meetsanctum/ui-sdk";

import { noRoomName, readingsOf, sensorReadings } from "./device-tiles";
import { placeMotionText } from "./motion";
import {
  LightsButton,
  lightsButton,
  PlaceReadings,
  unitOf,
} from "./place-pages";
import {
  RoomSection,
  sectionsInOrder,
  type SectionEntities,
} from "./room-sections";
import type { Devices } from "./use-devices";

// Home's rooms: after the home's status, each room by name that has
// something to show, under its name, which opens its page. A room's line has
// the button for all its lights and what its motion and sensors say, as its
// page's header does; then its apps' sections, its moods first, as on its
// page but with no heading of their own; then its devices on Home, in the
// household's order. Devices on Home with no room come last, under a name
// that opens their page as a room's does. A room's page
// stays complete and fixed; Home shows only what was put on it, so a sensor
// needs no tile here for its readings. A room with nothing to show is in the
// sidebar only.

/** The rooms on Home, and while nothing is on it, how to put something there. */
export function HomeRooms(props: {
  devices: Devices;
  /** Home's devices, in the household's order. */
  onHome: readonly string[] | undefined;
  /** What the household calls Home. */
  homeName: string;
  apps: readonly AppInfo[];
  entities: SectionEntities;
  openRoom: (roomId: string) => void;
  /** Opens the page of the devices in no room. */
  openNoRoom: () => void;
  openDevice: (tile: Tile) => void;
  onEdit: () => void;
}) {
  const { devices, entities } = props;
  const places = homePlaces(devices, props.onHome);
  const sections = sectionsInOrder(props.apps);
  const unit = unitOf(devices);
  const now = Date.now();
  // Devices with no room have no line of their own and no sections.
  const shown = places.flatMap((place) => {
    const { room, own, onHome } = place;
    const roomSections = room
      ? sections.filter(
          ({ app, section }) =>
            entities.tilesIn(app.id, section, room.id).length > 0,
        )
      : [];
    const lights = room
      ? lightsButton(
          own.filter((tile) => tile.kind === "light"),
          `the ${room.name} lights`,
          { kind: "room", id: room.id },
          devices,
        )
      : undefined;
    const motion = room ? placeMotionText(own, now) : null;
    const readings = room ? readingsOf(sensorReadings(own), unit) : [];
    const hasLine = !!lights || !!motion || readings.length > 0;
    return hasLine || roomSections.length > 0 || onHome.length > 0
      ? [
          {
            ...place,
            sections: roomSections,
            lights,
            motion,
            readings,
            hasLine,
          },
        ]
      : [];
  });
  const isEmpty =
    props.onHome !== undefined && places.every((place) => !place.onHome.length);
  return (
    <>
      {shown.map((place) => {
        const headingId = `home-${place.id}`;
        const { room, lights } = place;
        return (
          <section
            key={place.id}
            aria-labelledby={headingId}
            className="flex shrink-0 flex-col gap-3"
          >
            <h2
              id={headingId}
              className="m-0 text-[15px] leading-5 font-medium"
            >
              <Button
                variant="ghost"
                size="inline"
                type="button"
                onClick={() =>
                  room ? props.openRoom(room.id) : props.openNoRoom()
                }
              >
                {place.name}
                <icons.ChevronRight
                  aria-hidden="true"
                  className="size-4 text-white/65"
                />
              </Button>
            </h2>
            {place.hasLine && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {lights && <LightsButton lights={lights} />}
                <PlaceReadings
                  motion={place.motion}
                  readings={place.readings}
                  className="text-[13px] leading-[18px] font-medium [&_svg]:size-3.5"
                />
              </div>
            )}
            {room &&
              place.sections.map(({ app, section }) => (
                <RoomSection
                  key={app.id}
                  app={app}
                  section={section}
                  roomId={room.id}
                  entities={entities}
                  roomHas={() => false}
                  bare
                />
              ))}
            {place.onHome.length > 0 && (
              <div
                role="group"
                aria-label="On Home"
                className="grid auto-rows-(--cell) grid-cols-[repeat(auto-fill,var(--cell))] gap-(--cell-gap)"
              >
                {place.onHome.map((tile) => (
                  <DeviceTile
                    key={tile.key}
                    tile={tile}
                    onToggle={(each) =>
                      void devices.toggle(each).catch(() => undefined)
                    }
                    onDim={(each, brightness) =>
                      void devices.dim(each, brightness).catch(() => undefined)
                    }
                    onOpen={props.openDevice}
                  />
                ))}
              </div>
            )}
          </section>
        );
      })}
      {isEmpty && devices.devices.length > 0 && (
        <NothingOnHome name={props.homeName} onEdit={props.onEdit} />
      )}
    </>
  );
}

/**
 * The home's rooms by name, then devices with no room, each with its tiles
 * and those of its devices on Home, in the household's order: a device's
 * own tiles keep theirs.
 */
export function homePlaces(
  devices: Devices,
  onHome: readonly string[] | undefined,
) {
  const position = new Map((onHome ?? []).map((id, at) => [id, at]));
  const homeTiles = devices.tiles
    .filter((tile) => position.has(tile.deviceId))
    .sort(
      (a, b) =>
        position.get(a.deviceId)! - position.get(b.deviceId)! ||
        a.name.localeCompare(b.name),
    );
  const rooms = devices.places?.rooms ?? [];
  return [
    ...rooms.map((room) => ({ id: room.id, name: room.name, room })),
    { id: "no-room", name: noRoomName, room: null },
  ].map((place) => {
    const roomId = place.room?.id ?? null;
    return {
      ...place,
      own: devices.tiles.filter((tile) => tile.roomId === roomId),
      onHome: homeTiles.filter((tile) => tile.roomId === roomId),
    };
  });
}

// While nothing is on Home: how things get there, and Edit Home.
function NothingOnHome(props: { name: string; onEdit: () => void }) {
  return (
    <section
      aria-labelledby="nothing-on-home"
      className="flex w-[520px] max-w-full shrink-0 items-start gap-3.5 rounded-lg bg-(--glass) p-4 ps-3.5 text-(--glass-ink) shadow-[inset_0_0_0_1px_var(--glass-line)] backdrop-blur-[24px]"
    >
      <span className="grid size-10 shrink-0 place-items-center rounded-full bg-(--tile-chip)">
        <icons.House aria-hidden="true" className="size-[18px]" />
      </span>
      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="flex flex-col gap-0.5">
          <h2
            id="nothing-on-home"
            className="m-0 text-[15px] leading-[22px] font-medium"
          >
            Nothing is on {props.name} yet
          </h2>
          <p className="m-0 text-[13px] leading-[18px] font-medium text-(--silver)">
            Lights come here as they join. To keep a sensor, a remote or a plug
            here too, open it and choose Add to {props.name}.
          </p>
        </div>
        <Button variant="outline" onClick={props.onEdit} className="self-start">
          Edit {props.name}
        </Button>
      </div>
    </section>
  );
}

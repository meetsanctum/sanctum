import type { AppInfo } from "@meetsanctum/app-sdk";
import { Button, DeviceTile, icons, type Tile } from "@meetsanctum/ui-sdk";

import { placeContacts } from "./contact";
import { noRoomName, readingsOf, sensorReadings } from "./device-tiles";
import { byFloor, FloorSection, roomsOn } from "./floor-groups";
import { floorLightsButton, lightsButton } from "./lights-button";
import { placeMotionText } from "./motion";
import { PlaceReadings, unitOf } from "./place-pages";
import {
  isRowEmpty,
  RoomRow,
  roomRowOf,
  type SectionEntities,
} from "./room-sections";
import type { Devices } from "./use-devices";

// Home's rooms: after the home's status, each room by name that has
// something to show, under its name, which opens its page. A room's line
// says what its motion and sensors say, as its page's header does; then its
// row, its switch, Natural light and its moods, as on its page; then its
// devices on Home, in the household's order. Devices on Home
// with no room come last, under a name that opens their page as a room's
// does. A room's page stays complete and fixed; Home shows only what was put
// on it, so a sensor needs no tile here for its readings. A room with
// nothing to show is in the sidebar only. Once the home has floors, its
// rooms are under them (floor-groups.tsx), each floor's heading with the
// button that turns its lights off while any is on. Space groups them: a
// room's parts sit 12 px apart, rooms 32 px and floors 56 px, so each is
// closer to its own than to the next.

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
  const unit = unitOf(devices);
  const now = Date.now();
  // Devices with no room have no line of their own and no sections.
  const shown = places.flatMap((place) => {
    const { room, own, onHome } = place;
    const row = room
      ? roomRowOf(
          props.apps,
          entities,
          room.id,
          lightsButton(
            own.filter((tile) => tile.kind === "light"),
            room,
            devices,
          ),
        )
      : null;
    const motion = room ? placeMotionText(own, now) : null;
    const contact = room ? placeContacts(own) : null;
    const readings = room ? readingsOf(sensorReadings(own), unit) : [];
    const hasLine = !!motion || !!contact || readings.length > 0;
    const hasRow = row !== null && !isRowEmpty(row);
    return hasLine || hasRow || onHome.length > 0
      ? [
          {
            ...place,
            row: hasRow ? row : null,
            motion,
            contact,
            readings,
            hasLine,
          },
        ]
      : [];
  });
  const isEmpty =
    props.onHome !== undefined && places.every((place) => !place.onHome.length);
  const groups = byFloor(
    devices.places,
    shown,
    (place) => place.room?.id ?? null,
  );
  const homeLights = devices.tiles.filter((tile) => tile.kind === "light");

  // A room's section; its heading is a level down under a floor's.
  const roomSection = (place: (typeof shown)[number], level: 2 | 3) => {
    const headingId = `home-${place.id}`;
    const { room } = place;
    const Heading = level === 3 ? "h3" : "h2";
    return (
      <section
        key={place.id}
        aria-labelledby={headingId}
        className="flex shrink-0 flex-col gap-3"
      >
        <Heading
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
        </Heading>
        {place.hasLine && (
          <PlaceReadings
            motion={place.motion}
            contact={place.contact}
            readings={place.readings}
            className="text-[13px] leading-[18px] font-medium [&_svg]:size-3.5"
          />
        )}
        {place.row && (
          <RoomRow row={place.row} roomName={place.name} entities={entities} />
        )}
        {place.onHome.length > 0 && (
          <div
            role="group"
            aria-label="On Home"
            className="tile-grid auto-rows-(--cell)"
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
  };

  return (
    <>
      {shown.length > 0 &&
        (groups ? (
          <div className="flex shrink-0 flex-col gap-14 pt-2">
            {groups.map(({ floor, items }) => (
              <FloorSection
                key={floor?.id ?? "other-rooms"}
                floor={floor}
                id={`home-floor-${floor?.id ?? "other-rooms"}`}
                lights={
                  floor
                    ? floorLightsButton(
                        homeLights.filter(
                          (tile) =>
                            tile.roomId !== null &&
                            roomsOn(devices.places, floor).has(tile.roomId),
                        ),
                        floor,
                        devices,
                      )
                    : undefined
                }
              >
                {items.map((place) => roomSection(place, 3))}
              </FloorSection>
            ))}
          </div>
        ) : (
          <div className="flex shrink-0 flex-col gap-8 pt-2">
            {shown.map((place) => roomSection(place, 2))}
          </div>
        ))}
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

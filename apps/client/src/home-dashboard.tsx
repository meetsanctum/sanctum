import type { AppInfo, Floor, Room } from "@meetsanctum/app-sdk";
import {
  Button,
  DeviceTile,
  icons,
  useHomeClock,
  type Tile,
} from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { compare } from "@meetsanctum/app-sdk/words";

import { placeContacts } from "./contact";
import { noRoomName, readingsOf, sensorReadings } from "./device-tiles";
import { byFloor, FloorSection, roomsOn } from "./floor-groups";
import { floorLightsButton } from "./lights-button";
import { placeMotionText } from "./motion";
import { PlaceReadings, unitOf } from "./place-pages";
import {
  roomLightsKey,
  roomLightsTile,
  RoomLightsTile,
  useRoomLights,
  type RoomLights,
} from "./room-lights";
import {
  isRowEmpty,
  RoomRow,
  roomRowOf,
  sameRoomRow,
  type SectionEntities,
} from "./room-sections";
import { sameData, sameItems } from "./same-data";
import { useTileHandlers, type Devices } from "./use-devices";

const compareNames = compare("en");

// Home's rooms: after the home's status, each room by name that has
// something to show, under its name, which opens its page. A room's line
// says what its motion and sensors say, as its page's header does; then its
// row, Natural Light and its moods, as on its page; then under "Devices"
// its Lights tile (room-lights.tsx) and its devices on Home, in the
// household's order. Devices on Home
// with no room come last, under a name that opens their page as a room's
// does. A room's page stays complete and fixed; Home shows only what was put
// on it, so a sensor needs no tile here for its readings. A room with
// nothing to show is in the sidebar only. Once the home has floors, its
// rooms are under them (floor-groups.tsx), a floor with lights with its
// button that turns them off. Space groups them: a
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
  const { onToggle, onDim } = useTileHandlers(devices);
  const roomLights = useRoomLights(devices);
  const clock = useHomeClock();
  const places = homePlaces(devices, props.onHome);
  const unit = unitOf(devices);
  const now = Date.now();
  // Devices with no room have no line of their own and no sections.
  const shown = places.flatMap((place) => {
    const { room, own, onHome } = place;
    const lights = own.filter((tile) => tile.kind === "light");
    const row = room ? roomRowOf(props.apps, entities, room.id, lights) : null;
    const lightsTile = room
      ? roomLightsTile(
          lights,
          room.id,
          devices.failures.get(roomLightsKey(room.id)),
        )
      : undefined;
    const motion = room ? placeMotionText(clock, own, now) : null;
    const contact = room ? placeContacts(own) : null;
    const readings = room ? readingsOf(sensorReadings(own), unit) : [];
    const hasLine = !!motion || !!contact || readings.length > 0;
    const hasRow = row !== null && !isRowEmpty(row);
    return hasLine || hasRow || onHome.length > 0 || lightsTile
      ? [
          {
            id: place.id,
            name: place.name,
            room,
            onHome,
            lightsTile,
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
  const floorLights = (floor: Floor) => {
    const rooms = roomsOn(devices.places, floor);
    return homeLights.filter(
      (tile) => tile.roomId !== null && rooms.has(tile.roomId),
    );
  };

  // The same functions each time, calling the latest the page gave, so a
  // room that didn't change isn't drawn again.
  const opens = useRef({
    openRoom: props.openRoom,
    openNoRoom: props.openNoRoom,
  });
  useLayoutEffect(() => {
    opens.current = { openRoom: props.openRoom, openNoRoom: props.openNoRoom };
  });
  const openRoom = useCallback(
    (roomId: string) => opens.current.openRoom(roomId),
    [],
  );
  const openNoRoom = useCallback(() => opens.current.openNoRoom(), []);
  const roomSection = (place: (typeof shown)[number], level: 2 | 3) => (
    <HomeRoom
      key={place.id}
      place={place}
      level={level}
      press={entities.press}
      onToggle={onToggle}
      onDim={onDim}
      roomLights={roomLights}
      openDevice={props.openDevice}
      openRoom={openRoom}
      openNoRoom={openNoRoom}
    />
  );

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
                    ? floorLightsButton(floorLights(floor), floor, devices)
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

type HomeRoomProps = {
  place: {
    id: string;
    name: string;
    room: Room | null;
    /** Its devices on Home, in the household's order. */
    onHome: Tile[];
    /** Its Lights tile, for a room with lights. */
    lightsTile: Tile | undefined;
    row: ReturnType<typeof roomRowOf> | null;
    motion: string | null;
    contact: ReturnType<typeof placeContacts> | null;
    readings: ReturnType<typeof readingsOf>;
    hasLine: boolean;
  };
  /** Its heading's level, a level down under a floor's. */
  level: 2 | 3;
  press: SectionEntities["press"];
  onToggle: (tile: Tile) => void;
  onDim: (tile: Tile, brightness: number) => void;
  roomLights: RoomLights;
  openDevice: (tile: Tile) => void;
  openRoom: (roomId: string) => void;
  openNoRoom: () => void;
};

// A room draws again only when what it shows changed: its tiles keep their
// identity while unchanged, as do its app entries' source objects, and its
// Lights tile is compared by what it says.
function sameRoom(before: HomeRoomProps, after: HomeRoomProps) {
  const { onHome, row, ...place } = before.place;
  const { onHome: nextOnHome, row: nextRow, ...nextPlace } = after.place;
  return (
    before.level === after.level &&
    before.press === after.press &&
    before.onToggle === after.onToggle &&
    before.onDim === after.onDim &&
    before.roomLights === after.roomLights &&
    before.openDevice === after.openDevice &&
    before.openRoom === after.openRoom &&
    before.openNoRoom === after.openNoRoom &&
    sameItems(onHome, nextOnHome) &&
    sameRoomRow(row, nextRow) &&
    sameData(place, nextPlace)
  );
}

const HomeRoom = memo(function HomeRoom(props: HomeRoomProps) {
  const { place } = props;
  const headingId = `home-${place.id}`;
  const devicesId = `home-${place.id}-devices`;
  const { room } = place;
  const Heading = props.level === 3 ? "h3" : "h2";
  return (
    <RoomSection aria-labelledby={headingId}>
      <Heading id={headingId} className="m-0 text-[15px] leading-5 font-medium">
        <Button
          variant="ghost"
          size="inline"
          type="button"
          onClick={() => (room ? props.openRoom(room.id) : props.openNoRoom())}
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
        <RoomRow row={place.row} roomName={place.name} press={props.press} />
      )}
      {(place.lightsTile || place.onHome.length > 0) && (
        <div className="flex flex-col gap-2">
          <DevicesHeading id={devicesId} level={props.level}>
            Devices
          </DevicesHeading>
          <div
            role="group"
            aria-labelledby={devicesId}
            className="tile-grid auto-rows-(--cell)"
          >
            {place.lightsTile && (
              <RoomLightsTile
                tile={place.lightsTile}
                roomName={place.name}
                lights={props.roomLights}
                onOpen={props.openDevice}
              />
            )}
            {place.onHome.map((tile) => (
              <DeviceTile
                key={tile.key}
                tile={tile}
                onToggle={props.onToggle}
                onDim={props.onDim}
                onOpen={props.openDevice}
              />
            ))}
          </div>
        </div>
      )}
    </RoomSection>
  );
}, sameRoom);

// Over a room's devices on Home, every room's and No room's alike, so the
// row's tiles, such as its moods, and its devices, tiles of one size, read
// as two groups. It names the devices' group too. It is quieter than the
// room's name, in the room line's 13 px at 65%, and a level under it.
function DevicesHeading(props: { id: string; level: 2 | 3; children: string }) {
  const Heading = props.level === 3 ? "h4" : "h3";
  return (
    <Heading
      id={props.id}
      className="m-0 text-[13px] leading-[18px] font-medium text-(--tile-secondary)"
    >
      {props.children}
    </Heading>
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
        compareNames(a.name, b.name),
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
      className="flex w-[520px] max-w-full shrink-0 items-start gap-3.5 rounded-lg bg-(--glass) p-4 ps-3.5 text-(--glass-ink) shadow-[inset_0_0_0_1px_var(--glass-line)] frosted"
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

// A room off screen isn't styled or laid out until it nears the screen:
// with many rooms, a change over Home, such as a device's detail opening,
// otherwise styled them all again. It lays out in full once first, so the
// browser keeps its size (contain-intrinsic-size: auto) and nothing shifts
// as it comes into view. Its 4 px of padding, given back by the margin,
// keeps its tiles' focus rings inside what it paints.
function RoomSection(props: {
  "aria-labelledby": string;
  children: ReactNode;
}) {
  const [skipsOffScreen, setSkipsOffScreen] = useState(false);
  useEffect(() => {
    let later: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      later = setTimeout(() => setSkipsOffScreen(true));
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(later);
    };
  }, []);
  return (
    <section
      aria-labelledby={props["aria-labelledby"]}
      className={cn(
        "-m-1 flex shrink-0 flex-col gap-3 p-1 [contain-intrinsic-size:auto_320px]",
        skipsOffScreen && "[content-visibility:auto]",
      )}
    >
      {props.children}
    </section>
  );
}

import {
  deviceCategories,
  type AppInfo,
  type DeviceCategory,
  type DeviceType,
} from "@meetsanctum/app-sdk";
import {
  contactIcon,
  DeviceSections,
  icons,
  PageBar,
  type ContactShownAs,
  type LucideIcon,
  type PageParams,
  type Tile,
  type TileSection,
  useHomeClock,
} from "@meetsanctum/ui-sdk";
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

import { appsNotRunning, attentionTile, needingAttention } from "./attention";
import { categoryLooks, categoryOrder } from "./category-looks";
import {
  contactsOf,
  contactsStatus,
  contactsSummary,
  contactTypes,
  placeContacts,
} from "./contact";
import {
  climateMeasures,
  measureNames,
  noRoomName,
  noRoomSection,
  onMeta,
  readingsOf,
  sectionsByRoom,
  sectionsOfRoom,
  sensorReadings,
  switchesSummary,
  tilesIn,
  type Reading,
} from "./device-tiles";
import { useEdgeFade } from "./edge-fade";
import { byFloor, FloorSection } from "./floor-groups";
import { floorLightsButton } from "./lights-button";
import { LightsCard, lightsStatus } from "./lights-card";
import { batteriesTile } from "./maintenance";
import { mediaSummary } from "./media";
import { homeMotion, motionWhere, placeMotionText } from "./motion";
import { PresenceOverview } from "./presence-overview";
import { LightsTileOf, useRoomLights } from "./room-lights";
import {
  isRowEmpty,
  RoomRow,
  roomRowOf,
  type SectionEntities,
} from "./room-sections";
import { SidebarHeading, SidebarItem } from "./sidebar-item";
import { SidebarRooms } from "./sidebar-rooms";
import { statusRow, statusTile, StatusTileWords } from "./status-tile";
import { SummaryCards, type Summary } from "./summary-cards";
import type { HostProblem, ServiceNotSetUp } from "./system-status";
import { useTileHandlers, type Devices } from "./use-devices";
import { useKeyedHandlers } from "./keyed-handlers";

// Room and category pages: the shell's, drawn from Places and Devices,
// complete and fixed. A room's page opens with its name, what its sensors
// read, whether its contact sensors are open and its motion, then its
// row: Natural Light and its moods (room-sections.tsx), then its devices in
// a section for each category, its Lights tile first among its lights
// (room-lights.tsx), and last the devices Sanctum cannot use. A category's page shows its tiles in a section
// for each room, devices with no room last. Some open with summary cards
// (summary-cards.tsx), Environment's with the range of each reading across
// the home, Security's with how many contact sensors are open, Switches'
// and Media's with how many of each type are on or playing; Lights'
// opens with its card, how many are on with a switch that turns them off
// (lights-card.tsx). Presence's opens
// with its overview, each room's last 24 hours (presence-overview.tsx).
// On Lights' page each room also has its button for all its lights, as on
// Home. The devices in no room have a page too, last among the rooms while
// there are any. The sidebar lists them, and Home shows each room's line and
// row with what is on Home (home-dashboard.tsx). They look the
// same on every device, shared ones too: lights, switches and sensors are
// household things.

/** Where the shell's own pages are in its routes; never an app's id, which always has a dot. */
export const placePages = "places";

/** The page of the devices in no room, among the shell's own. */
export const noRoomPage = "no-room";

const readingIcons: Record<Reading["measure"], LucideIcon> = {
  temperature: icons.Thermometer,
  humidity: icons.Droplet,
  illuminance: icons.Sun,
};

export const unitOf = (devices: Devices) =>
  devices.places?.home.temperatureUnit ?? "celsius";

// A room's or a category's page has its name in the top bar, as a
// dashboard and an app's page do, and on a phone opening the page
// (PageBar). A room's opens with what its sensors read, offline ones left
// out, its contact sensors and its motion; a category's has only its name.
function PlaceHeader(props: {
  title: string;
  /** Its motion in words, last in the line of readings. */
  motion?: string | null;
  /** Its contact sensors in words, before its motion. */
  contact?: PlaceContact | null;
  readings?: Reading[];
}) {
  const hasLine = !!props.motion || !!props.contact || !!props.readings?.length;
  if (!hasLine) return <PageBar title={props.title} />;
  return (
    <header className="flex shrink-0 flex-col gap-2.5">
      <PageBar title={props.title} />
      <div className="flex flex-col gap-0.5 empty:hidden">
        <PlaceReadings
          motion={props.motion}
          contact={props.contact}
          readings={props.readings}
          className="text-[15px] leading-[22px] [&_svg]:size-4"
        />
      </div>
    </header>
  );
}

/** A place's contact sensors as its line says them (contact.ts). */
export type PlaceContact = {
  text: string;
  open: boolean;
  isUnknown: boolean;
  /** The door or window its glyph is, where its sensors are all one. */
  shownAs?: ContactShownAs;
  /** What it counts, said before it for a screen reader; none where its words name it. */
  label: string | null;
};

/**
 * What a place's sensors read, whether its contact sensors are open and its
 * motion, in a line: under a room page's name, and under a room's name on
 * Home. They come in the categories' order, Environment's temperature,
 * humidity and light level, then Security, then Presence. Nothing without
 * any.
 */
export function PlaceReadings(props: {
  motion?: string | null;
  contact?: PlaceContact | null;
  readings?: Reading[];
  className: string;
}) {
  const { contact } = props;
  const Contact = contactIcon(contact?.shownAs, contact?.open === true);
  if (!props.motion && !contact && !props.readings?.length) return null;
  return (
    <p
      data-slot="readings"
      className={`m-0 flex flex-wrap gap-x-4 gap-y-1 ${props.className}`}
    >
      {props.readings?.map((each) => {
        const Icon = readingIcons[each.measure];
        return (
          <span
            key={each.measure}
            className="inline-flex items-center gap-1.5 tabular-nums"
          >
            <Icon aria-hidden="true" className="text-white/65" />
            <span className="sr-only">{measureNames[each.measure]} </span>
            {each.text}
          </span>
        );
      })}
      {contact && (
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <Contact
            aria-hidden="true"
            className="text-white/65"
            strokeDasharray={contact.isUnknown ? "3 3" : undefined}
          />
          {contact.label && <span className="sr-only">{contact.label} </span>}
          {contact.text}
        </span>
      )}
      {props.motion && (
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <icons.Footprints aria-hidden="true" className="text-white/65" />
          {props.motion}
        </span>
      )}
    </p>
  );
}

// The tiles, switched and dimmed through the shell's device state, each
// opening its device's detail. A refusal or a failure shows on the tile.
function Sections(props: {
  sections: TileSection[];
  devices: Devices;
  onOpen: (tile: Tile) => void;
  /** What a section has at the start of its grid. */
  firstTile?: (section: TileSection) => ReactNode;
  /** Its headings' level, 3 under a floor's. */
  level?: 2 | 3;
}) {
  const { onToggle, onDim } = useTileHandlers(props.devices);
  return (
    <DeviceSections
      sections={props.sections}
      onToggle={onToggle}
      onDim={onDim}
      onOpen={props.onOpen}
      firstTile={props.firstTile}
      level={props.level}
    />
  );
}

const sidebarCategories = categoryOrder.map((id) =>
  deviceCategories.find((each) => each.id === id)!,
);

// A remote has nothing to say in the home's status.
const statusCategories = sidebarCategories.filter(
  (category) => category.id !== "buttons",
);

// A tile of the home's status: what it is about, what it says, and what it opens.
type StatusTile = {
  key: string;
  title: string;
  value: string;
  label: string;
  icon: LucideIcon;
  colour: string;
  open: () => void;
};

type StatusItem =
  StatusTile | { key: "lights"; tiles: Tile[]; open: () => void };

/**
 * The home's status on the dashboard: Lights' card, with its switch
 * (lights-card.tsx), then a tile for what the sensors read, how many
 * contact sensors are open, where there is motion and how many switches
 * are on, each opening its category. While Sanctum, an app or any device
 * needs attention, a tile opens Settings, where they show first, or Status
 * when only Sanctum does: first, in red, while something is wrong, so a
 * problem is the first thing seen, and otherwise last, in Graphite, where it
 * moves nothing as it comes and goes. Last of all, while a battery is to
 * replace, comes Batteries, in Graphite, which opens Maintenance.
 */
export function HomeStatus(props: {
  devices: Devices;
  // What needs someone about Sanctum itself (system-status.ts), and its
  // page.
  problems?: readonly HostProblem[];
  // The services the home never set up, whose apps wait for nothing wrong.
  notSetUp?: readonly ServiceNotSetUp[];
  apps: readonly AppInfo[];
  openCategory: (id: DeviceCategory) => void;
  openAttention: () => void;
  openStatus?: () => void;
  openMaintenance: () => void;
}) {
  const clock = useHomeClock();
  const { devices } = props;
  const row = useRef<HTMLElement>(null);
  useEdgeFade(row);
  const unit = unitOf(devices);
  const shown = statusCategories.flatMap((category): StatusItem[] => {
    const { id } = category;
    const own = tilesIn(category, devices.tiles);
    if (own.length === 0) return [];
    const open = () => props.openCategory(id);
    if (id === "lights") return [{ key: id, tiles: own, open }];
    const status = categoryStatus(id, own, devices);
    if (!status) return [];
    const look = categoryLooks[id];
    return [
      {
        key: id,
        title: category.title,
        value: status.value,
        label: `${category.title}, ${status.spoken}`,
        icon: look.icon,
        colour: look.colour,
        open,
      },
    ];
  });
  const attention = attentionTile(
    needingAttention(devices.devices, devices.places?.rooms ?? [], props.apps),
    props.problems ?? [],
    unit,
    appsNotRunning(props.apps, props.notSetUp),
  );
  const hasProblem = attention?.problem ?? false;
  useLayoutEffect(() => {
    // Reveal the tile when it moves to the front of a scrolled row.
    if (hasProblem && row.current) row.current.scrollLeft = 0;
  }, [hasProblem]);

  if (attention) {
    const tile: StatusItem = {
      key: "attention",
      title: attention.title,
      value: attention.value,
      label: attention.label,
      icon: icons.CircleAlert,
      // Red for a problem, Graphite while there are only rooms to choose.
      colour: attention.problem ? "var(--danger)" : "var(--graphite-text)",
      open:
        attention.opens === "status"
          ? (props.openStatus ?? props.openAttention)
          : props.openAttention,
    };
    if (attention.problem) shown.unshift(tile);
    else shown.push(tile);
  }
  const batteries = batteriesTile(clock, devices.devices, Date.now());
  if (batteries) {
    shown.push({
      key: "batteries",
      ...batteries,
      icon: icons.BatteryWarning,
      colour: "var(--graphite-text)",
      open: props.openMaintenance,
    });
  }
  if (shown.length === 0) return null;
  return (
    <section ref={row} aria-label="Home status" className={statusRow}>
      {shown.map((each) => {
        if ("tiles" in each) {
          return (
            <LightsCard
              key={each.key}
              tiles={each.tiles}
              devices={devices}
              open={each.open}
            />
          );
        }
        return (
          <button
            key={each.key}
            type="button"
            aria-label={each.label}
            onClick={each.open}
            className={`${statusTile} outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50`}
          >
            <StatusTileWords
              icon={each.icon}
              colour={each.colour}
              title={each.title}
              value={each.value}
            />
          </button>
        );
      })}
    </section>
  );
}

/**
 * What a category's status tile on Home says, which its item in the sidebar
 * says too: how many lights or switches are on, the temperatures (never the
 * light level), where there is motion, or how many contact sensors are
 * open, with its words for a screen reader. Buttons have nothing to say.
 * The sidebar names one room with motion at most, so its words fit and
 * change less as people move about.
 */
function categoryStatus(
  id: DeviceCategory,
  own: readonly Tile[],
  devices: Devices,
  where: "home" | "sidebar" = "home",
): { value: string; spoken: string } | undefined {
  const said = (value: string) => ({ value, spoken: value });
  switch (id) {
    case "lights":
      return said(lightsStatus(own).value);
    case "environment": {
      const [reading] = readingsOf(
        sensorReadings(own),
        unitOf(devices),
        climateMeasures,
      );
      return reading
        ? { value: reading.text, spoken: reading.spoken }
        : said("No readings");
    }
    case "presence": {
      const motion = homeMotion(own, devices.places);
      return said(
        motion.answering
          ? motionWhere(motion, where === "sidebar" ? 1 : 2)
          : "No readings",
      );
    }
    case "security": {
      const contacts = contactsOf(own);
      return said(contacts ? contactsStatus(contacts) : "No readings");
    }
    case "switches":
      return said(onMeta(own));
    case "media": {
      const playing = own.filter((tile) => tile.media?.playing).length;
      return said(playing > 0 ? `${playing} playing` : "Not playing");
    }
    case "buttons":
      return undefined;
  }
}

export function RoomPage(props: {
  roomId: string;
  devices: Devices;
  apps: readonly AppInfo[];
  entities: SectionEntities;
  /** Opens a device's detail from its tile. */
  openDevice: (tile: Tile) => void;
  back: () => void;
}) {
  const { roomId, devices, entities, back } = props;
  const clock = useHomeClock();
  const roomLights = useRoomLights(devices);
  const room = devices.places?.rooms.find((each) => each.id === roomId);
  // A room removed meanwhile leaves its page.
  const gone = devices.places !== undefined && !room;
  useEffect(() => {
    if (gone) back();
  }, [gone, back]);
  if (!room) return null;
  const own = devices.tiles.filter((tile) => tile.roomId === room.id);
  const lights = own.filter((tile) => tile.kind === "light");
  const row = roomRowOf(props.apps, entities, room.id, lights);
  return (
    <>
      <PlaceHeader
        title={room.name}
        motion={placeMotionText(clock, own, Date.now())}
        contact={placeContacts(own)}
        readings={readingsOf(sensorReadings(own), unitOf(devices))}
      />
      {!isRowEmpty(row) && (
        <RoomRow row={row} roomName={room.name} press={entities.press} />
      )}
      <Sections
        sections={sectionsOfRoom(own, devices.devices, lights.length > 0)}
        devices={devices}
        onOpen={props.openDevice}
        firstTile={(section) =>
          section.id === "lights" ? (
            <LightsTileOf
              lights={lights}
              room={room}
              devices={devices}
              roomLights={roomLights}
              onOpen={props.openDevice}
            />
          ) : null
        }
      />
    </>
  );
}

const inNoRoom = (devices: Devices) =>
  devices.tiles.filter((tile) => tile.roomId === null);

// The devices in no room have a page like a room's: their tiles in a
// section for each category. It leaves out what needs a place: a line of
// motion and readings and a button for all its lights, since its devices
// are not together, and apps' sections, which belong to a room. Once every
// device has a room, the page leaves, as a removed room's does.
export function NoRoomPage(props: {
  devices: Devices;
  openDevice: (tile: Tile) => void;
  back: () => void;
}) {
  const { devices, back } = props;
  const own = inNoRoom(devices);
  const gone = devices.loaded && own.length === 0;
  useEffect(() => {
    if (gone) back();
  }, [gone, back]);
  if (own.length === 0) return null;
  return (
    <>
      <PlaceHeader title={noRoomName} />
      <Sections
        sections={sectionsOfRoom(own, devices.devices)}
        devices={devices}
        onOpen={props.openDevice}
      />
    </>
  );
}

// What Environment's page opens with: a card for each reading the home
// ranges across its sensors, with how many of them are not known.
function environmentCards(
  tiles: readonly Tile[],
  unit: ReturnType<typeof unitOf>,
): Summary[] {
  return climateMeasures.flatMap((measure) => {
    const own = tiles.filter((tile) => tile.measures?.includes(measure));
    if (own.length === 0) return [];
    const [reading] = readingsOf(sensorReadings(own), unit, [measure]);
    const known = own.filter(
      (tile) => !tile.disabled && tile.readings?.[measure] !== undefined,
    ).length;
    return [
      {
        id: measure,
        icon: readingIcons[measure],
        title: measureNames[measure],
        status: reading?.text ?? "No readings",
        spoken: reading?.spoken,
        note:
          reading && known < own.length
            ? `${own.length - known} not known`
            : null,
      },
    ];
  });
}

// What Security's page opens with: a card for each type of contact sensor
// the home has, its doors, its windows and those shown as neither.
function securityCards(tiles: readonly Tile[]): Summary[] {
  return contactTypes.flatMap(({ type, title }) => {
    const contacts = contactsOf(tiles, type);
    if (!contacts) return [];
    const { open, status, note } = contactsSummary(contacts);
    return [
      {
        id: type,
        icon: contactIcon(type === "contact" ? null : type, open),
        title,
        status,
        note,
      },
    ];
  });
}

// What Media's page opens with: a card for each type the home's players are
// shown as, how many of them are playing.
const mediaIcons: Partial<Record<DeviceType, icons.LucideIcon>> = {
  tv: icons.Tv,
  speaker: icons.Speaker,
  "smart-speaker": icons.Speaker,
};

function mediaCards(tiles: readonly Tile[], devices: Devices): Summary[] {
  return mediaSummary(tiles, devices.devices).map((each) => ({
    id: each.type,
    icon: mediaIcons[each.type] ?? icons.TvMinimalPlay,
    title: each.title,
    status: each.status,
    note: null,
  }));
}

// What Switches' page opens with: a card for its plugs and one for its
// other switches, how many of them are on.
function switchCards(tiles: readonly Tile[], devices: Devices): Summary[] {
  return switchesSummary(tiles, devices.devices).map((each) => ({
    id: each.type,
    icon: each.type === "plug" ? icons.Plug : icons.ToggleRight,
    title: each.title,
    status: each.status,
    note: null,
  }));
}

export function CategoryPage(props: {
  id: string;
  devices: Devices;
  openDevice: (tile: Tile) => void;
  /** Opens a room's page over this one, from Presence's overview. */
  openRoom: (roomId: string) => void;
  back: () => void;
}) {
  const { devices, back } = props;
  const category = deviceCategories.find((each) => each.id === props.id);
  useEffect(() => {
    if (!category) back();
  }, [category, back]);
  if (!category) return null;
  const own = tilesIn(category, devices.tiles);
  return (
    <>
      <PlaceHeader title={category.title} />
      {category.id === "lights" && own.length > 0 && (
        <div className="flex shrink-0">
          <LightsCard tiles={own} devices={devices} />
        </div>
      )}
      {category.id === "environment" && (
        <SummaryCards
          label={`${category.title} summary`}
          colour={categoryLooks.environment.colour}
          cards={environmentCards(own, unitOf(devices))}
        />
      )}
      {category.id === "presence" && (
        <PresenceOverview devices={devices} openRoom={props.openRoom} />
      )}
      {category.id === "security" && (
        <SummaryCards
          label={`${category.title} summary`}
          colour={categoryLooks.security.colour}
          cards={securityCards(own)}
        />
      )}
      {category.id === "switches" && (
        <SummaryCards
          label={`${category.title} summary`}
          colour={categoryLooks.switches.colour}
          cards={switchCards(own, devices)}
        />
      )}
      {category.id === "media" && (
        <SummaryCards
          label={`${category.title} summary`}
          colour={categoryLooks.media.colour}
          cards={mediaCards(own, devices)}
        />
      )}
      <CategorySections
        sections={sectionsByRoom(own, devices.places)}
        devices={devices}
        onOpen={props.openDevice}
        isLights={category.id === "lights"}
      />
    </>
  );
}

// A category's rooms, under their floors once the home has floors
// (floor-groups.tsx), so a room is where it is on Home. On Lights' page each
// room's Lights tile comes first among its lights (room-lights.tsx), and
// each floor has its button that turns them off (lights-button.tsx).
function CategorySections(props: {
  sections: TileSection[];
  devices: Devices;
  onOpen: (tile: Tile) => void;
  isLights: boolean;
}) {
  const { devices, isLights } = props;
  const roomLights = useRoomLights(devices);
  const firstTile = isLights
    ? (section: TileSection) =>
        // The lights in no room are not together, so have no Lights tile.
        section.id === noRoomSection ? null : (
          <LightsTileOf
            lights={section.tiles}
            room={{ id: section.id, name: section.title }}
            devices={devices}
            roomLights={roomLights}
            onOpen={props.onOpen}
          />
        )
    : undefined;
  const groups = byFloor(devices.places, props.sections, (section) =>
    section.id === noRoomSection ? null : section.id,
  );
  if (!groups) {
    return (
      <Sections
        sections={props.sections}
        devices={devices}
        onOpen={props.onOpen}
        firstTile={firstTile}
      />
    );
  }
  return (
    <div className="flex shrink-0 flex-col gap-14">
      {groups.map(({ floor, items }) => (
        <FloorSection
          key={floor?.id ?? "other-rooms"}
          floor={floor}
          id={`category-floor-${floor?.id ?? "other-rooms"}`}
          lights={
            isLights && floor
              ? floorLightsButton(
                  items.flatMap((section) => section.tiles),
                  floor,
                  devices,
                )
              : undefined
          }
        >
          <Sections
            sections={items}
            devices={devices}
            onOpen={props.onOpen}
            firstTile={firstTile}
            level={3}
          />
        </FloorSection>
      ))}
    </div>
  );
}

// The places in the sidebar, after the dashboards: the categories the home
// has devices for, each saying what its status tile on Home says, then the
// rooms (sidebar-rooms.tsx), each group under its heading. While any device
// is in no room, No room comes last among the rooms, the only one in a home
// that has none yet.
export function SidebarPlaces(props: {
  devices: Devices;
  /** The place on show, if any. */
  current: { page: string; params: PageParams } | null;
  open: (
    page: "room" | "category" | typeof noRoomPage,
    params: PageParams,
  ) => void;
}) {
  const { devices, current, open } = props;
  const shown = sidebarCategories
    .map((category) => ({
      ...category,
      tiles: tilesIn(category, devices.tiles),
    }))
    .filter((category) => category.tiles.length > 0);
  const hasNoRoom = inNoRoom(devices).length > 0;
  // Keep callbacks stable for the items still in the sidebar.
  const openCategory = useKeyedHandlers(
    (id: string) => open("category", { id }),
    shown.map(({ id }) => id),
  );
  const openNoRoom = useKeyedHandlers(
    () => open(noRoomPage, {}),
    [noRoomPage],
  )(noRoomPage);
  return (
    <>
      {shown.length > 0 && <SidebarHeading>Categories</SidebarHeading>}
      {shown.map((category) => (
        <SidebarItem
          key={category.id}
          icon={categoryLooks[category.id].icon}
          colour={categoryLooks[category.id].colour}
          name={category.title}
          meta={categoryStatus(category.id, category.tiles, devices, "sidebar")}
          current={
            current?.page === "category" && current.params.id === category.id
          }
          onSelect={openCategory(category.id)}
        />
      ))}
      <SidebarRooms
        places={devices.places}
        currentRoom={
          current?.page === "room" ? (current.params.id ?? null) : null
        }
        hasNoRoom={hasNoRoom}
        isNoRoomCurrent={current?.page === noRoomPage}
        openRoom={(id) => open("room", { id })}
        openNoRoom={openNoRoom}
      />
    </>
  );
}

import {
  deviceCategories,
  type AppInfo,
  type DeviceCategory,
} from "@meetsanctum/app-sdk";
import {
  Button,
  contactIcon,
  DeviceSections,
  icons,
  PageBar,
  type ContactShownAs,
  type LucideIcon,
  type PageParams,
  type Tile,
  type TileSection,
} from "@meetsanctum/ui-sdk";
import { useEffect, type ReactNode } from "react";

import { appsNotRunning, attentionTile, needingAttention } from "./attention";
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
  onMeta,
  readingsOf,
  sectionsByRoom,
  sectionsOfRoom,
  sensorReadings,
  tilesIn,
  type Reading,
} from "./device-tiles";
import { batteriesTile } from "./maintenance";
import { homeMotion, motionWhere, placeMotionText } from "./motion";
import { PresenceOverview } from "./presence-overview";
import {
  RoomSection,
  sectionsInOrder,
  type AppSection,
  type SectionEntities,
} from "./room-sections";
import { SidebarHeading, SidebarItem } from "./sidebar-item";
import { SummaryCards, type Summary } from "./summary-cards";
import type { HostProblem, ServiceNotSetUp } from "./system-status";
import type { Devices } from "./use-devices";

// Room and category pages: the shell's, drawn from Places and Devices,
// complete and fixed. A room's page opens with its name, its motion, whether
// its contact sensors are open and what its sensors read under it, and a
// button for all its lights, then apps' sections by their weight, Moods
// first, then its devices in a section for each category, and last the
// devices Sanctum cannot use. A category's page shows its tiles in a section
// for each room, devices with no room last. Some open with summary cards
// (summary-cards.tsx): Lights' with how many are on and a button that turns
// them all off, Environment's with the range of each reading across the
// home, Security's with how many contact sensors are open. Presence's opens
// with its overview, each room's last 24 hours (presence-overview.tsx).
// On Lights' page each room also has its button for all its lights, as on
// Home. The devices in no room have a page too, last among the rooms while
// there are any. The sidebar lists them, and Home shows each room's header
// and sections with what is on Home (home-dashboard.tsx). They look the
// same on every device, shared ones too: lights, switches and sensors are
// household things.

/** Where the shell's own pages are in its routes; never an app's id, which always has a dot. */
export const placePages = "places";

/** The page of the devices in no room, among the shell's own. */
export const noRoomPage = "no-room";

// A category's icon and colour, for each the SDK lists.
const categoryLooks: Record<
  DeviceCategory,
  { icon: LucideIcon; colour: string }
> = {
  lights: { icon: icons.Lightbulb, colour: "var(--sun-text)" },
  switches: { icon: icons.Plug, colour: "var(--ember-text)" },
  environment: { icon: icons.Thermometer, colour: "var(--sky-text)" },
  presence: { icon: icons.Footprints, colour: "var(--leaf-text)" },
  // An open window is a fact and no warning, so Security is never red.
  security: { icon: icons.Shield, colour: "var(--iris-text)" },
  buttons: { icon: icons.CircleDot, colour: "var(--graphite-text)" },
};

const readingIcons: Record<Reading["measure"], LucideIcon> = {
  temperature: icons.Thermometer,
  humidity: icons.Droplet,
  illuminance: icons.Sun,
};

export const unitOf = (devices: Devices) =>
  devices.places?.home.temperatureUnit ?? "celsius";

const onCount = (tiles: Tile[]) => tiles.filter((tile) => tile.on).length;

/**
 * What a room's button for all its lights says: what it does, with how
 * many lights are on, since a room's line has no other count of them.
 */
export const lightsWords = (on: number) =>
  on === 0
    ? "Turn lights on"
    : on === 1
      ? "Turn 1 light off"
      : `Turn ${on} lights off`;

/** A room's button for all its lights, as lightsButton makes it. */
export type LightsSwitch = {
  on: number;
  /** Its words with the room's name, where several rooms' buttons are in reach. */
  label: string;
  disabled?: boolean;
  onToggle: () => void;
};

// A room's or a category's page has its name in the top bar, as a
// dashboard and an app's page do, and on a phone opening the page
// (PageBar). A room's opens with its motion and what its sensors read,
// offline ones left out, and a button for all its lights, white while any
// is on; a category's with its status.
function PlaceHeader(props: {
  title: string;
  subtitle?: string;
  /** Its motion in words, first in the line of readings. */
  motion?: string | null;
  /** Its contact sensors in words, after its motion. */
  contact?: PlaceContact | null;
  readings?: Reading[];
  lights?: LightsSwitch;
}) {
  const { lights } = props;
  const hasLine =
    !!props.subtitle ||
    !!props.motion ||
    !!props.contact ||
    !!props.readings?.length;
  if (!hasLine && !lights) return <PageBar title={props.title} />;
  return (
    <header className="flex shrink-0 flex-col gap-2.5">
      <PageBar title={props.title} />
      <div className="flex flex-col gap-0.5 empty:hidden">
        {props.subtitle && (
          <p className="m-0 text-[13px] leading-[18px] font-medium text-white/65">
            {props.subtitle}
          </p>
        )}
        <PlaceReadings
          motion={props.motion}
          contact={props.contact}
          readings={props.readings}
          className="text-[15px] leading-[22px] [&_svg]:size-4"
        />
      </div>
      {lights && (
        <div className="flex flex-wrap gap-2">
          <LightsButton lights={lights} />
        </div>
      )}
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
 * A place's motion, whether its contact sensors are open and what its
 * sensors read, in a line: under a room page's name, and beside a room's
 * lights on Home. Nothing without any.
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
      {props.motion && (
        <span className="inline-flex items-center gap-1.5 tabular-nums">
          <icons.Footprints aria-hidden="true" className="text-white/65" />
          {props.motion}
        </span>
      )}
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
    </p>
  );
}

/**
 * A room's button for all its lights. Its words say what it does and its
 * look says how the room is, White while any light is on, so it is no
 * pressed switch to a screen reader: the words already say it.
 */
export function LightsButton(props: { lights: LightsSwitch }) {
  const { lights } = props;
  return (
    <Button
      variant="glass"
      size="chip"
      aria-label={lights.label}
      data-on={lights.on > 0 ? "" : undefined}
      disabled={lights.disabled}
      onClick={lights.onToggle}
    >
      <icons.Lightbulb aria-hidden="true" data-icon="inline-start" />
      {lightsWords(lights.on)}
    </Button>
  );
}

// The tiles, switched and dimmed through the shell's device state, each
// opening its device's detail. A refusal or a failure shows on the tile.
function Sections(props: {
  sections: TileSection[];
  devices: Devices;
  onOpen: (tile: Tile) => void;
  /** What a section has between its heading and its tiles. */
  lead?: (section: TileSection) => ReactNode;
}) {
  const { devices } = props;
  return (
    <DeviceSections
      sections={props.sections}
      onToggle={(tile) => void devices.toggle(tile).catch(() => undefined)}
      onDim={(tile, brightness) =>
        void devices.dim(tile, brightness).catch(() => undefined)
      }
      onOpen={props.onOpen}
      lead={props.lead}
    />
  );
}

// The button for every light in a room: White while any is on, and saying
// what it does, "Turn 2 lights off" or "Turn lights on". The core leaves
// offline lights alone, so while all of them are offline the button is
// disabled, as their tiles are. The home has no such button: turning every
// light in it on at once is more than one press should do, so its lights
// can only be turned off, from Lights' card.
export function lightsButton(
  lights: Tile[],
  room: { id: string; name: string },
  devices: Devices,
): LightsSwitch | undefined {
  if (lights.length === 0) return undefined;
  const on = onCount(lights);
  return {
    on,
    label: `${lightsWords(on)} in ${room.name}`,
    disabled: lights.every((tile) => tile.disabled),
    onToggle: () =>
      void devices
        .switchLights(
          { kind: "room", id: room.id },
          lights,
          on > 0 ? "off" : "on",
        )
        .catch(() => undefined),
  };
}

const statusOrder = [
  "environment",
  "presence",
  "security",
  "lights",
  "switches",
] as const satisfies DeviceCategory[];

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

/**
 * The home's status on the dashboard: a tile for what the sensors read,
 * where there is motion, how many contact sensors are open, how many
 * lights and switches are on, each opening
 * its category, and last, while Sanctum or any device needs attention, one
 * that opens Settings, where they show first, or Status when only Sanctum
 * does, then, while a battery is to replace, Batteries, in Graphite, which
 * opens Maintenance; being last, they move nothing as they come and go.
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
  const { devices } = props;
  const unit = unitOf(devices);
  // What the sensors read first, the most glanceable; a remote has nothing
  // to say here.
  const shown = statusOrder.flatMap((id): StatusTile[] => {
    const category = deviceCategories.find((each) => each.id === id)!;
    const own = tilesIn(category, devices.tiles);
    if (own.length === 0) return [];
    let value: string;
    let label: string;
    if (category.id === "environment") {
      // The temperatures when they have any; never the light level.
      const [reading] = readingsOf(sensorReadings(own), unit, climateMeasures);
      value = reading?.text ?? "No readings";
      label = reading?.spoken ?? value;
    } else if (category.id === "presence") {
      const motion = homeMotion(own, devices.places);
      value = motion.answering ? motionWhere(motion) : "No readings";
      label = value;
    } else if (category.id === "security") {
      const contacts = contactsOf(own);
      value = contacts ? contactsStatus(contacts) : "No readings";
      label = value;
    } else {
      value = onMeta(own);
      label = value;
    }
    const look = categoryLooks[category.id];
    return [
      {
        key: category.id,
        title: category.title,
        value,
        label: `${category.title}, ${label}`,
        icon: look.icon,
        colour: look.colour,
        open: () => props.openCategory(category.id),
      },
    ];
  });
  const attention = attentionTile(
    needingAttention(devices.devices, devices.places?.rooms ?? [], props.apps),
    props.problems ?? [],
    unit,
    appsNotRunning(props.apps, props.notSetUp),
  );
  if (attention) {
    shown.push({
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
    });
  }
  const batteries = batteriesTile(devices.devices, Date.now());
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
    <section
      aria-label="Home status"
      className="grid shrink-0 auto-rows-(--cell) grid-cols-[repeat(auto-fill,var(--cell))] gap-(--cell-gap)"
    >
      {shown.map((each) => {
        return (
          <button
            key={each.key}
            type="button"
            aria-label={each.label}
            onClick={each.open}
            className="col-span-2 flex min-w-0 items-center gap-2.5 rounded-lg bg-(--tile) px-3.5 py-3 text-left text-(--tile-ink) backdrop-blur-[24px] outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <each.icon
              aria-hidden="true"
              className="size-[18px] shrink-0"
              style={{ color: each.colour }}
            />
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[13px] leading-[18px] font-medium text-(--tile-secondary)">
                {each.title}
              </span>
              <span className="truncate text-[15px] leading-5 font-medium tabular-nums">
                {each.value}
              </span>
            </span>
          </button>
        );
      })}
    </section>
  );
}

export function RoomPage(props: {
  roomId: string;
  devices: Devices;
  apps: readonly AppInfo[];
  entities: SectionEntities;
  /** Opens an app's page over this one, if the shell has it. */
  openApp: (app: string, page: string, params: PageParams) => void;
  canOpen: (app: string, page: string) => boolean;
  /** Opens a device's detail from its tile. */
  openDevice: (tile: Tile) => void;
  back: () => void;
}) {
  const { roomId, devices, entities, back } = props;
  const room = devices.places?.rooms.find((each) => each.id === roomId);
  // A room removed meanwhile leaves its page.
  const gone = devices.places !== undefined && !room;
  useEffect(() => {
    if (gone) back();
  }, [gone, back]);
  if (!room) return null;
  const own = devices.tiles.filter((tile) => tile.roomId === room.id);
  const kinds = new Set(
    devices.devices
      .filter((device) => device.roomId === room.id)
      .flatMap((device) => device.capabilities.map((each) => each.kind)),
  );
  const sections = sectionsInOrder(props.apps);
  const appSection = ({ app, section }: AppSection) => (
    <RoomSection
      key={app.id}
      app={app}
      section={section}
      roomId={room.id}
      entities={entities}
      roomHas={(kind) => kinds.has(kind)}
      onOpen={
        section.open && props.canOpen(app.id, section.open.page)
          ? () =>
              props.openApp(app.id, section.open!.page, { placeId: room.id })
          : undefined
      }
    />
  );
  return (
    <>
      <PlaceHeader
        title={room.name}
        motion={placeMotionText(own, Date.now())}
        contact={placeContacts(own)}
        readings={readingsOf(sensorReadings(own), unitOf(devices))}
        lights={lightsButton(
          own.filter((tile) => tile.kind === "light"),
          room,
          devices,
        )}
      />
      {sections.map(appSection)}
      <Sections
        sections={sectionsOfRoom(own)}
        devices={devices}
        onOpen={props.openDevice}
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
        sections={sectionsOfRoom(own)}
        devices={devices}
        onOpen={props.openDevice}
      />
    </>
  );
}

// What Lights' page opens with: a card that says how many lights are on,
// with the one thing to do about them, turning them all off. A light that
// does not answer is not counted as off: the card says how many are
// offline, or "Offline" when none answers.
function lightsCards(tiles: readonly Tile[], devices: Devices): Summary[] {
  if (tiles.length === 0) return [];
  const offline = tiles.filter((tile) => tile.disabled).length;
  const on = tiles.filter((tile) => tile.on && !tile.disabled).length;
  return [
    {
      id: "lights",
      icon: on > 0 ? icons.Lightbulb : icons.LightbulbOff,
      title: "Lights",
      status:
        on > 0 ? `${on} on` : offline === tiles.length ? "Offline" : "All off",
      note: offline > 0 && offline < tiles.length ? `${offline} offline` : null,
      active: on > 0,
      action: {
        label: "Turn all off",
        onPress: () =>
          devices.switchLights({ kind: "home" }, [...tiles], "off").then(
            ({ failed }) =>
              failed.length === 0
                ? "Lights turned off"
                : `${failed.length} ${failed.length === 1 ? "light" : "lights"} did not turn off`,
            () => "The lights could not be turned off",
          ),
      },
    },
  ];
}

// What Environment's page opens with: a card for each reading the home
// ranges across its sensors, with how many of them are not known. Nothing
// here is on or open, so its cards are never White.
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
        active: false,
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
        active: open,
      },
    ];
  });
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
      <PlaceHeader
        title={category.title}
        subtitle={
          category.id === "switches" ? onMeta(own) || undefined : undefined
        }
      />
      {category.id === "lights" && (
        <SummaryCards
          label={`${category.title} summary`}
          cards={lightsCards(own, devices)}
        />
      )}
      {category.id === "environment" && (
        <SummaryCards
          label={`${category.title} summary`}
          cards={environmentCards(own, unitOf(devices))}
        />
      )}
      {category.id === "presence" && (
        <PresenceOverview devices={devices} openRoom={props.openRoom} />
      )}
      {category.id === "security" && (
        <SummaryCards
          label={`${category.title} summary`}
          cards={securityCards(own)}
        />
      )}
      <Sections
        sections={sectionsByRoom(own, devices.places)}
        devices={devices}
        onOpen={props.openDevice}
        lead={
          category.id === "lights"
            ? (section) => {
                // The lights in no room are not together, so have no button.
                const room = devices.places?.rooms.find(
                  (each) => each.id === section.id,
                );
                const lights =
                  room && lightsButton(section.tiles, room, devices);
                return lights ? (
                  <div className="flex">
                    <LightsButton lights={lights} />
                  </div>
                ) : null;
              }
            : undefined
        }
      />
    </>
  );
}

// The places in the sidebar, after the dashboards: the categories the home
// has devices for, then the rooms, each group under its heading. Only Lights
// says how many are on; the rest would be noise. While any device is in no
// room, No room comes last among the rooms, the only one in a home that has
// none yet.
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
  const shown = deviceCategories
    .map((category) => ({
      ...category,
      tiles: tilesIn(category, devices.tiles),
    }))
    .filter((category) => category.tiles.length > 0);
  const rooms = devices.places?.rooms ?? [];
  const hasNoRoom = inNoRoom(devices).length > 0;
  return (
    <>
      {shown.length > 0 && <SidebarHeading>Categories</SidebarHeading>}
      {shown.map((category) => (
        <SidebarItem
          key={category.id}
          icon={categoryLooks[category.id].icon}
          colour={categoryLooks[category.id].colour}
          name={category.title}
          meta={category.id === "lights" ? onMeta(category.tiles) : undefined}
          current={
            current?.page === "category" && current.params.id === category.id
          }
          onSelect={() => open("category", { id: category.id })}
        />
      ))}
      {(rooms.length > 0 || hasNoRoom) && (
        <>
          <SidebarHeading>Rooms</SidebarHeading>
          {rooms.map((room) => (
            <SidebarItem
              key={room.id}
              icon={icons.DoorOpen}
              name={room.name}
              current={
                current?.page === "room" && current.params.id === room.id
              }
              onSelect={() => open("room", { id: room.id })}
            />
          ))}
          {hasNoRoom && (
            <SidebarItem
              icon={icons.SquareDashed}
              name={noRoomName}
              current={current?.page === noRoomPage}
              onSelect={() => open(noRoomPage, {})}
            />
          )}
        </>
      )}
    </>
  );
}

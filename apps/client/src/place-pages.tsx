import type { AppInfo, LightsPlace } from "@meetsanctum/app-sdk";
import {
  Button,
  DeviceSections,
  icons,
  PageBar,
  type LucideIcon,
  type PageParams,
  type Tile,
  type TileSection,
} from "@meetsanctum/ui-sdk";
import { useEffect } from "react";

import { appsNotRunning, attentionTile, needingAttention } from "./attention";
import {
  categories,
  climateMeasures,
  measureNames,
  onMeta,
  readingsOf,
  readingsText,
  sectionsByCategory,
  sectionsByRoom,
  sensorReadings,
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
import type { HostProblem } from "./system-status";
import type { Devices } from "./use-devices";

// Room and category pages: the shell's, drawn from Places and Devices,
// complete and fixed. A room's page opens with its name, its motion and what
// its sensors read under it, and a button for all its lights, then apps'
// sections by their weight, Moods first, then its devices in a section for
// each category. A category's page shows its tiles in a section for each
// room, devices with no room last; Lights' opens with a button for every
// light in the home, Climate with what every sensor reads, and Presence
// with its overview, each room's last 24 hours (presence-overview.tsx),
// above its sensors. The sidebar lists them, and Home shows each
// room's header and sections with what is on Home (home-dashboard.tsx).
// They look the same on every device, shared ones too: lights, switches
// and sensors are household things.

/** Where the shell's own pages are in its routes; never an app's id, which always has a dot. */
export const placePages = "places";

const categoryLooks: Record<
  Tile["kind"],
  { icon: LucideIcon; colour: string }
> = {
  light: { icon: icons.Lightbulb, colour: "var(--sun-text)" },
  switch: { icon: icons.Plug, colour: "var(--ember-text)" },
  sensor: { icon: icons.Thermometer, colour: "var(--sky-text)" },
  occupancy: { icon: icons.Footprints, colour: "var(--leaf-text)" },
  button: { icon: icons.CircleDot, colour: "var(--graphite-text)" },
};

const readingIcons: Record<Reading["measure"], LucideIcon> = {
  temperature: icons.Thermometer,
  humidity: icons.Droplet,
  illuminance: icons.Sun,
};

export const unitOf = (devices: Devices) =>
  devices.places?.home.temperatureUnit ?? "celsius";

const onCount = (tiles: Tile[]) => tiles.filter((tile) => tile.on).length;

export const lightsOn = (on: number) =>
  on === 0 ? "Lights off" : on === 1 ? "1 Light on" : `${on} Lights on`;

/** A place's button for all its lights, as lightsButton makes it. */
export type LightsSwitch = {
  on: number;
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
  readings?: Reading[];
  lights?: LightsSwitch;
}) {
  const { lights } = props;
  const hasLine =
    !!props.subtitle || !!props.motion || !!props.readings?.length;
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

/**
 * A place's motion and what its sensors read, in a line: under a room
 * page's name, and beside a room's lights on Home. Nothing without either.
 */
export function PlaceReadings(props: {
  motion?: string | null;
  readings?: Reading[];
  className: string;
}) {
  if (!props.motion && !props.readings?.length) return null;
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

/** A place's button for all its lights: white while any is on. */
export function LightsButton(props: { lights: LightsSwitch }) {
  const { lights } = props;
  return (
    <Button
      variant="glass"
      size="chip"
      aria-label={lights.label}
      aria-pressed={lights.on > 0}
      disabled={lights.disabled}
      onClick={lights.onToggle}
    >
      <icons.Lightbulb aria-hidden="true" data-icon="inline-start" />
      {lightsOn(lights.on)}
    </Button>
  );
}

// The tiles, switched and dimmed through the shell's device state, each
// opening its device's detail. A refusal or a failure shows on the tile.
function Sections(props: {
  sections: TileSection[];
  devices: Devices;
  onOpen: (tile: Tile) => void;
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
    />
  );
}

// The button for every light in a room or the home: white while any is on.
// The core leaves offline lights alone, so while all of them are offline
// the button is disabled, as their tiles are.
export function lightsButton(
  lights: Tile[],
  name: string,
  place: LightsPlace,
  devices: Devices,
): LightsSwitch | undefined {
  if (lights.length === 0) return undefined;
  const on = onCount(lights);
  return {
    on,
    label: `Turn ${on ? "off" : "on"} ${name}`,
    disabled: lights.every((tile) => tile.disabled),
    onToggle: () =>
      void devices.switchLights(place, lights).catch(() => undefined),
  };
}

const statusOrder = ["sensor", "occupancy", "light", "switch"] as const;

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
 * where there is motion, how many lights and switches are on, each opening
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
  apps: readonly AppInfo[];
  openCategory: (kind: Tile["kind"]) => void;
  openAttention: () => void;
  openStatus?: () => void;
  openMaintenance: () => void;
}) {
  const { devices } = props;
  const unit = unitOf(devices);
  // What the sensors read first, the most glanceable; a remote has nothing
  // to say here.
  const shown = statusOrder.flatMap((kind): StatusTile[] => {
    const category = categories.find((each) => each.kind === kind)!;
    const own = devices.tiles.filter((tile) => tile.kind === category.kind);
    if (own.length === 0) return [];
    let value: string;
    let label: string;
    if (category.kind === "sensor") {
      // The temperatures when they have any; never the light level.
      const [reading] = readingsOf(sensorReadings(own), unit, climateMeasures);
      value = reading?.text ?? "No readings";
      label = reading?.spoken ?? value;
    } else if (category.kind === "occupancy") {
      const motion = homeMotion(own, devices.places);
      value = motion.answering ? motionWhere(motion) : "No readings";
      label = value;
    } else {
      value = onMeta(own);
      label = value;
    }
    const look = categoryLooks[category.kind];
    return [
      {
        key: category.kind,
        title: category.title,
        value,
        label: `${category.title}, ${label}`,
        icon: look.icon,
        colour: look.colour,
        open: () => props.openCategory(category.kind),
      },
    ];
  });
  const attention = attentionTile(
    needingAttention(devices.devices, devices.places?.rooms ?? [], props.apps),
    props.problems ?? [],
    unit,
    appsNotRunning(props.apps),
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
        readings={readingsOf(sensorReadings(own), unitOf(devices))}
        lights={lightsButton(
          own.filter((tile) => tile.kind === "light"),
          `the ${room.name} lights`,
          { kind: "room", id: room.id },
          devices,
        )}
      />
      {sections.map(appSection)}
      <Sections
        sections={sectionsByCategory(own)}
        devices={devices}
        onOpen={props.openDevice}
      />
    </>
  );
}

export function CategoryPage(props: {
  kind: string;
  devices: Devices;
  openDevice: (tile: Tile) => void;
  /** Opens a room's page over this one, from Presence's overview. */
  openRoom: (roomId: string) => void;
  back: () => void;
}) {
  const { devices, back } = props;
  const category = categories.find((each) => each.kind === props.kind);
  useEffect(() => {
    if (!category) back();
  }, [category, back]);
  if (!category) return null;
  const own = devices.tiles.filter((tile) => tile.kind === category.kind);
  return (
    <>
      {category.kind === "light" ? (
        <PlaceHeader
          title={category.title}
          lights={lightsButton(
            own,
            "all the lights",
            { kind: "home" },
            devices,
          )}
        />
      ) : (
        <PlaceHeader
          title={category.title}
          subtitle={
            category.kind === "button" || category.kind === "occupancy"
              ? undefined
              : category.kind === "sensor"
                ? readingsText(
                    sensorReadings(own),
                    unitOf(devices),
                    climateMeasures,
                  ) || undefined
                : onMeta(own) || undefined
          }
        />
      )}
      {category.kind === "occupancy" && (
        <PresenceOverview devices={devices} openRoom={props.openRoom} />
      )}
      <Sections
        sections={sectionsByRoom(own, devices.places)}
        devices={devices}
        onOpen={props.openDevice}
      />
    </>
  );
}

// The places in the sidebar, after the dashboards: the categories the home
// has devices for, then the rooms, each group under its heading. Only Lights
// says how many are on; the rest would be noise.
export function SidebarPlaces(props: {
  devices: Devices;
  /** The place on show, if any. */
  current: { page: string; params: PageParams } | null;
  open: (page: "room" | "category", params: PageParams) => void;
}) {
  const { devices, current, open } = props;
  const shown = categories
    .map((category) => ({
      ...category,
      tiles: devices.tiles.filter((tile) => tile.kind === category.kind),
    }))
    .filter((category) => category.tiles.length > 0);
  const rooms = devices.places?.rooms ?? [];
  return (
    <>
      {shown.length > 0 && <SidebarHeading>Categories</SidebarHeading>}
      {shown.map((category) => (
        <SidebarItem
          key={category.kind}
          icon={categoryLooks[category.kind].icon}
          colour={categoryLooks[category.kind].colour}
          name={category.title}
          meta={category.kind === "light" ? onMeta(category.tiles) : undefined}
          current={
            current?.page === "category" &&
            current.params.kind === category.kind
          }
          onSelect={() => open("category", { kind: category.kind })}
        />
      ))}
      {rooms.length > 0 && (
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
        </>
      )}
    </>
  );
}

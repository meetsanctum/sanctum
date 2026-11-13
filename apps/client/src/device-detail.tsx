import type {
  CapabilityKind,
  DeviceInfo,
  LightFeatures,
} from "@meetsanctum/app-sdk";
import {
  AppScope,
  Button,
  deviceKindsOf,
  LightControls,
  SwipePages,
  usePhone,
  type LiveFeed,
} from "@meetsanctum/ui-sdk";
import { Blocks, Footprints, House, Sun, Thermometer } from "lucide-react";
import { useEffect, useId } from "react";

import { activityPage } from "./activity/device-page";
import { AppNotice, isShown, WhileNotRunning } from "./app-state";
import type { HostedApp } from "./apps";
import type { OnHome } from "./dashboards";
import { useMinuteClock } from "./device-firmware";
import { historyPage } from "./device-history";
import { noRoomName } from "./device-tiles";
import { MotionPage } from "./motion-detail";
import { Overlay } from "./overlay";
import { SensorDetail } from "./sensor-detail";
import { seenText } from "./settings-clients";
import type { Devices } from "./use-devices";

// A device's detail, opened from its tile: an overlay, with the controls
// straight on its glass and no card. Its name, room and status sit in the
// header with Done, and opposite Done, Add to Home, which says On Home while
// it is; its pages follow, its History last (device-history.tsx). Commands
// go through core Devices as the tiles' do, so a failure shows here and on
// its tile. Done, Escape and a click around the controls close it, and so
// does the connection's veil, as it closes the sidebar. It is the same on
// every device: lights and switches are household things. A sensor's first
// page is its readings and their history, and its header says when it last
// said something, since sensors on a battery say little (sensor-detail.tsx).
// A motion sensor's first is its motion (motion-detail.tsx), then its
// readings; it opens on the page of the tile it was opened from. A device
// with nothing of the shell's to set, such as a remote, shows the pages apps
// add for its kind instead, each drawn by its app in the app's scope, such
// as Moods' Presses. Every device's last page is its Activity: who did what
// to it (activity/device-page.tsx).

type Occupancy = Extract<
  DeviceInfo["capabilities"][number],
  { kind: "occupancy" }
>;

// What a switch has: on and off, which its controls show as one button.
const switchFeatures: LightFeatures = {
  brightness: false,
  colorTemperature: null,
  color: false,
};

// The pages apps add to the detail of a device of these kinds, in the
// order of the apps, each with the device as its app may see it.
function devicePages(
  apps: readonly HostedApp[],
  device: DeviceInfo,
  kinds: readonly CapabilityKind[],
) {
  return apps.flatMap((app) => {
    const reads = deviceKindsOf(app.info.permissions).reads;
    const seen = {
      ...device,
      capabilities: device.capabilities.filter((each) => reads.has(each.kind)),
    };
    if (!isShown(app.info)) return [];
    return app.info.provides.devicePages.flatMap((page) => {
      const Page = app.ui.devicePages?.[page.id];
      return Page && page.kinds.some((kind) => kinds.includes(kind))
        ? [{ app, id: page.id, title: page.title, Page, device: seen }]
        : [];
    });
  });
}

export function DeviceDetail(props: {
  container: HTMLElement | null;
  /** The tile it shows, kept while it closes. */
  tileKey: string | null;
  open: boolean;
  devices: Devices;
  /** The apps whose pages a device's detail may show. */
  apps: readonly HostedApp[];
  live: LiveFeed;
  /** What is on Home, which its header changes. */
  home: OnHome;
  onClose: () => void;
  /** Says it has come over the window, or has gone. */
  onCovering: (covering: boolean) => void;
  /** Opens the home's Activity, showing this device's. */
  onShowActivity: (device: string) => void;
  /** Opens an app's settings, for an app's page while the app isn't running. */
  onOpenAppSettings: (app: string) => void;
  onOpenStatus: () => void;
}) {
  const { devices, onClose } = props;
  const now = new Date(useMinuteClock());
  const tile = devices.tiles.find((each) => each.key === props.tileKey);
  const device = devices.devices.find((each) => each.id === tile?.deviceId);
  const capability = device?.capabilities.find(
    (each) => each.id === tile?.capabilityId,
  );
  // A motion sensor's detail is the same from its motion's tile and from
  // its readings', and shows the motion whose tile opened it.
  const motion =
    capability?.kind === "occupancy"
      ? capability
      : device?.capabilities.find(
          (each): each is Occupancy => each.kind === "occupancy",
        );
  const sensorLike =
    capability?.kind === "sensor" || capability?.kind === "occupancy";
  const pages =
    device && capability
      ? devicePages(
          props.apps,
          device,
          sensorLike && motion
            ? [
                ...new Set(
                  device.capabilities
                    .map((each) => each.kind)
                    .filter(
                      (kind) => kind === "sensor" || kind === "occupancy",
                    ),
                ),
              ]
            : [capability.kind],
        )
      : [];
  const history = device && capability ? historyPage(device, capability) : null;
  const activity =
    device && capability
      ? activityPage(device, capability, {
          where: "device",
          apps: props.apps.map((app) => app.info),
          rooms: (id) =>
            devices.places?.rooms.find((room) => room.id === id)?.name ?? null,
          live: props.live,
          onShowAll: props.onShowActivity,
        })
      : null;
  // A device removed meanwhile closes its detail.
  const gone = props.open && devices.places !== undefined && !capability;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);

  const room = devices.places?.rooms.find((each) => each.id === tile?.roomId);
  const status =
    device?.availability === "offline"
      ? `Offline · ${seenText(device.lastSeenAt, now)}`
      : sensorLike
        ? device?.lastSeenAt
          ? seenText(device.lastSeenAt, now).replace(/^Seen/, "Updated")
          : tile?.status
        : tile?.status;
  // The pages apps add, as one page of the detail.
  const fromApps =
    pages.length > 0
      ? [
          {
            id: "apps",
            label:
              pages.length === 1
                ? `${pages[0]!.title}, from ${pages[0]!.app.info.name}`
                : "From apps",
            icon: Blocks,
            content: (
              <AppPages
                pages={pages}
                openSettings={props.onOpenAppSettings}
                openStatus={props.onOpenStatus}
              />
            ),
          },
        ]
      : [];

  return (
    <Overlay
      container={props.container}
      open={props.open && capability !== undefined}
      onClose={onClose}
      onCovering={props.onCovering}
      title={tile?.name ?? ""}
      subtitle={tile && `${room?.name ?? noRoomName} · ${status}`}
      leading={
        device &&
        props.home.devices && (
          <OnHomeButton
            device={device}
            home={props.home}
            on={props.home.devices.includes(device.id)}
          />
        )
      }
    >
      {tile &&
        device &&
        capability &&
        (capability.kind === "sensor" || capability.kind === "occupancy" ? (
          <SwipePages
            // Each tile's detail opens afresh, on its own page.
            key={tile.key}
            label={tile.name}
            initial={capability.kind === "sensor" ? "readings" : undefined}
            pages={[
              ...(motion
                ? [
                    {
                      id: "motion",
                      label: "Motion",
                      icon: Footprints,
                      content: (
                        <MotionPage
                          key={`${device.id}/${motion.id}`}
                          device={device}
                          capability={motion}
                        />
                      ),
                    },
                  ]
                : []),
              ...(device.capabilities.some((each) => each.kind === "sensor")
                ? [
                    {
                      id: "readings",
                      label: "Readings",
                      // The light level's sun for a sensor that reads only
                      // it, as its tile has.
                      icon: device.capabilities.every(
                        (each) =>
                          each.kind !== "sensor" ||
                          each.features.measures === "illuminance",
                      )
                        ? Sun
                        : Thermometer,
                      content: (
                        <SensorDetail
                          device={device}
                          unit={
                            devices.places?.home.temperatureUnit ?? "celsius"
                          }
                          // The Motion page has its battery.
                          battery={!motion}
                        />
                      ),
                    },
                  ]
                : []),
              ...fromApps,
              ...(activity ? [activity] : []),
            ]}
          />
        ) : capability.kind === "button" ? (
          <SwipePages
            label={tile.name}
            // The pages apps add, when any does; Activity otherwise.
            pages={[...fromApps, ...(activity ? [activity] : [])]}
          />
        ) : (
          <LightControls
            key={tile.key}
            name={tile.name}
            features={
              capability.kind === "light" ? capability.features : switchFeatures
            }
            state={capability.state ?? { on: false }}
            disabled={tile.disabled}
            failures={tile.failures}
            onCommand={(command) =>
              void devices.command(tile, command).catch(() => undefined)
            }
            // The pages apps add, then History and Activity.
            pages={[
              ...fromApps,
              ...[history, activity].flatMap((page) => page ?? []),
            ]}
          />
        ))}
    </Overlay>
  );
}

// Apps' pages for the device, one after the other in a column 520 px wide
// at most, each under the shell's notice while its app isn't running.
function AppPages(props: {
  pages: ReturnType<typeof devicePages>;
  openSettings: (app: string) => void;
  openStatus: () => void;
}) {
  return (
    <div className="flex w-[520px] max-w-full flex-col gap-8">
      {props.pages.map(({ app, id, Page, device }) => (
        <AppScope key={`${app.info.id}/${id}/${device.id}`} client={app.client}>
          <div className="flex flex-col gap-3">
            <AppNotice
              app={app.info}
              permissionsAre="settings"
              openSettings={() => props.openSettings(app.info.id)}
              openStatus={props.openStatus}
            />
            <WhileNotRunning app={app.info} className="flex flex-col">
              <Page device={device} />
            </WhileNotRunning>
          </div>
        </AppScope>
      ))}
    </div>
  );
}

// Puts the device on Home or takes it off: Add to Home, White with a filled
// house as On Home while it is. On a phone only its house shows, so the
// title keeps its room; its words stay for screen readers, with what
// pressing it then does.
function OnHomeButton(props: {
  device: DeviceInfo;
  home: OnHome;
  on: boolean;
}) {
  const { device, home, on } = props;
  const isPhone = usePhone();
  return (
    <Button
      variant="outline"
      size={isPhone ? "bar" : "default"}
      data-on={on ? "" : undefined}
      onClick={() =>
        void (on ? home.remove(device.id) : home.add(device.id)).catch(
          () => undefined,
        )
      }
      className="min-w-0"
    >
      {on ? <FilledHouse /> : <House aria-hidden="true" />}
      <span className={isPhone ? "sr-only" : "truncate"}>
        {on ? `On ${home.name}` : `Add to ${home.name}`}
      </span>
      {on && <span className="sr-only">, remove from {home.name}</span>}
    </Button>
  );
}

// Lucide's house filled, with its door cut out, as On Home shows it.
function FilledHouse() {
  const door = useId();
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <mask id={door}>
        <rect width="24" height="24" fill="white" />
        <rect x="9.75" y="12.5" width="4.5" height="10" rx="1" fill="black" />
      </mask>
      <path
        d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinejoin="round"
        mask={`url(#${door})`}
      />
    </svg>
  );
}

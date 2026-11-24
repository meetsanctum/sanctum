import type {
  CapabilityKind,
  DeviceInfo,
  LightFeatures,
  MediaCommand,
} from "@meetsanctum/app-sdk";
import { registerPermission } from "@meetsanctum/app-sdk";
import {
  Button,
  contactIcon,
  deviceKindsOf,
  LightControls,
  SwipePages,
  usePhone,
  type LiveFeed,
} from "@meetsanctum/ui-sdk";
import {
  Blocks,
  Footprints,
  House,
  Play,
  Sun,
  Thermometer,
  Volume2,
} from "lucide-react";
import { useEffect, useId, useRef, useState, type ComponentProps } from "react";

import { activityPage } from "./activity/device-page";
import { AppNotice, isShown, WhileNotRunning } from "./app-state";
import type { HostedApp } from "./apps";
import { useArtwork } from "./artwork";
import { contactPageName } from "./contact";
import { DeviceFrame } from "./frames/device-frame";
import { isMedia, mediaText } from "./media";
import { mediaHistoryPage } from "./media-history";
import {
  MediaPlaying,
  MediaRemote,
  MediaVolume,
  MicrophonesToggle,
  missingArtworkTint,
  RemoteIcon,
} from "./media-detail";
import { ContactPage } from "./contact-detail";
import type { OnHome } from "./dashboards";
import { useMinuteClock } from "./device-firmware";
import { historyPage } from "./device-history";
import {
  isSwitchable,
  noRoomName,
  primaryKindOf,
  tileKey,
} from "./device-tiles";
import { MotionPage } from "./motion-detail";
import { Overlay } from "./overlay";
import { SensorDetail } from "./sensor-detail";
import { seenText } from "./settings-clients";
import { ChartPageSelected } from "./use-chart-clock";
import type { Devices } from "./use-devices";

// A device's detail, opened from any of its tiles: an overlay, with the
// controls straight on its glass and no card. Its name, room and status sit
// in the header with Done, and opposite Done, Add to Home, which says On
// Home while it is. Its pages are the device's, in one order whichever
// tile opened it: its light's or switch's controls, a media player's
// Playing and its Remote or Volume (media-detail.tsx), its Motion
// (motion-detail.tsx), its Contact (contact-detail.tsx), its Readings and
// their history (sensor-detail.tsx), the pages apps add for its kinds, each
// drawn by its app in the app's scope, such as Moods' Presses, its light's
// or switch's History (device-history.tsx) or a media player's
// (media-history.tsx), and last its Activity: who did what to it
// (activity/device-page.tsx). It opens on the page of the tile it was
// opened from, so a room's tile for the whole device opens it on the first,
// and its readings' tile under Environment on Readings. A device's further
// light or switch has a tile of its own, whose detail has that one's
// controls and History in place of the first's. Commands go through core
// Devices as the tiles' do, so a failure shows here and on its tile. Done,
// Escape and a click around the controls close it, and so does the
// connection's veil, as it closes the sidebar. It is the same on every
// device: lights and switches are household things. A device with nothing
// to switch says in its header when it last said something, since sensors
// on a battery say little. For a device Sanctum cannot use, Activity is the
// only page unless its driver adds one.

type Motion = Extract<DeviceInfo["capabilities"][number], { kind: "motion" }>;
type Contact = Extract<DeviceInfo["capabilities"][number], { kind: "contact" }>;

// The page a tile of each kind opens the detail on: its own.
const pageOf: Partial<Record<CapabilityKind, string>> = {
  motion: "motion",
  contact: "contact",
  sensor: "readings",
  media: "playing",
};

// What a switch has: on and off, which its controls show as one button.
const switchFeatures: LightFeatures = {
  brightness: false,
  colorTemperature: null,
  color: false,
};

// The pages apps add to the detail of a device of these kinds, in the
// order of the apps, each with the device as its app may see it, and a
// driver's pages on its own devices, with all of each.
export function devicePages(apps: readonly HostedApp[], device: DeviceInfo) {
  const kinds = new Set(device.capabilities.map((each) => each.kind));
  return apps.flatMap((app) => {
    if (!isShown(app.info)) return [];
    const isDriver = device.driver === app.info.id;
    const reads = deviceKindsOf(app.info.permissions).reads;
    const seen =
      isDriver && app.info.permissions.includes(registerPermission)
        ? device
        : {
            ...device,
            capabilities: device.capabilities.filter((each) =>
              reads.has(each.kind),
            ),
          };
    return app.info.provides.devicePages
      .filter((page) =>
        page.devices === "own"
          ? isDriver
          : page.kinds.some((kind) => kinds.has(kind)),
      )
      .map((page) => ({ ...page, app, device: seen }));
  });
}

export function DeviceDetail(props: {
  container: HTMLElement | null;
  /** The tile it shows, kept while it closes. */
  tileKey: string | null;
  /** A room's tile opens on the device's first page. */
  openFirstPage?: boolean;
  open: boolean;
  /** Whether the overlay is still over the window, including its exit fade. */
  isCovering: boolean;
  devices: Devices;
  /** The apps whose pages a device's detail may show. */
  apps: readonly HostedApp[];
  live: LiveFeed;
  /** What is on Home, which its header changes. */
  home: OnHome;
  onClose: () => void;
  /** Whether the home is away, as while it updates, which its apps' pages wait out. */
  isAway?: boolean;
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
  // A device Sanctum cannot use, whose tile stands for the device itself.
  const unknown = tile?.kind === "unknown" ? device : undefined;
  const hasDetail = capability !== undefined || unknown !== undefined;
  // The light or switch whose tile opened it, or the one on the room's tile.
  const controls = device?.capabilities.filter(isSwitchable) ?? [];
  const primaryKind = device && primaryKindOf(device.type);
  const control =
    capability && isSwitchable(capability)
      ? capability
      : (controls.find((each) => each.kind === primaryKind) ?? controls[0]);
  const controlTile =
    device &&
    control &&
    devices.tiles.find((each) => each.key === tileKey(device.id, control.id));
  // The motion or contact whose tile opened it, or the device's first.
  const motion =
    capability?.kind === "motion"
      ? capability
      : device?.capabilities.find(
          (each): each is Motion => each.kind === "motion",
        );
  const contact =
    capability?.kind === "contact"
      ? capability
      : device?.capabilities.find(
          (each): each is Contact => each.kind === "contact",
        );
  // The media player whose tile opened it, or the device's first.
  const openedPlayer = capability?.kind === "media" ? capability : undefined;
  const player = openedPlayer ?? device?.capabilities.find(isMedia);
  const playerTile =
    device &&
    player &&
    devices.tiles.find((each) => each.key === tileKey(device.id, player.id));
  const contactShownAs =
    device?.shownAs === "door" || device?.shownAs === "window"
      ? device.shownAs
      : undefined;
  const hasReadings = device?.capabilities.some(
    (each) => each.kind === "sensor",
  );
  const pages = device && hasDetail ? devicePages(props.apps, device) : [];
  const buttonPage =
    !props.openFirstPage && capability?.kind === "button"
      ? (pages.find((page) => page.kinds.includes("button")) ??
        pages.find((page) => page.devices === "own"))
      : undefined;
  const history =
    device && control && !openedPlayer
      ? historyPage(device, control)
      : device && player
        ? mediaHistoryPage(device, player)
        : null;
  const activity =
    device && hasDetail
      ? activityPage(device, {
          where: "device",
          apps: props.apps.map((app) => app.info),
          rooms: (id) =>
            devices.places?.rooms.find((room) => room.id === id)?.name ?? null,
          live: props.live,
          onShowAll: props.onShowActivity,
        })
      : null;
  // A device removed meanwhile closes its detail.
  const gone = props.open && devices.places !== undefined && !hasDetail;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);

  const name = openedPlayer
    ? ((props.openFirstPage ? device?.name : tile?.name) ?? "")
    : (controlTile?.name ?? device?.name ?? "");
  const room = devices.places?.rooms.find((each) => each.id === tile?.roomId);
  const status =
    device?.availability === "offline"
      ? `Offline · ${seenText(device.lastSeenAt, now)}`
      : openedPlayer
        ? mediaText(openedPlayer, { what: false })
        : controlTile
          ? controlTile.status
          : (motion || contact || hasReadings) && device?.lastSeenAt
            ? seenText(device.lastSeenAt, now).replace(/^Seen/, "Updated")
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
                initialPage={buttonPage === pages[0] ? undefined : buttonPage}
                openSettings={props.onOpenAppSettings}
                openStatus={props.onOpenStatus}
                household={devices.places?.home}
                isAway={props.isAway ?? false}
                onEscape={onClose}
              />
            ),
          },
        ]
      : [];
  // The picture of what it plays, and its colour on the veil, while
  // something does.
  const isMediaActive = Boolean(
    (props.open || props.isCovering) &&
    player?.state &&
    player.state.on !== false &&
    player.state.activity !== "idle",
  );
  const artworkHash = isMediaActive ? player?.state?.media?.artwork : null;
  const found = useArtwork(artworkHash);
  const [failedArtworkUrl, setFailedArtworkUrl] = useState<string | null>(null);
  const artwork =
    found !== "missing" && found?.url !== failedArtworkUrl ? found : null;
  const isArtworkMissing =
    isMediaActive && !artwork && (!artworkHash || found !== null);
  const mediaProps = player &&
    device &&
    playerTile && {
      name: playerTile.name,
      device,
      capability: player,
      disabled: playerTile.disabled,
      failures: playerTile.failures,
      onCommand: (command: MediaCommand) =>
        void devices.command(playerTile, command).catch(() => undefined),
    };
  const audio = device?.capabilities.find(
    (each) =>
      each.kind === "audio" &&
      each.features.mutes &&
      each.observed?.muted !== undefined,
  );
  const microphones = device && audio?.kind === "audio" && (
    <MicrophonesToggle
      key={tileKey(device.id, audio.id)}
      name={mediaProps ? mediaProps.name : device.name}
      muted={audio.observed?.muted === true}
      disabled={device.availability === "offline" || audio.sync === "pending"}
      failures={devices.failures.get(tileKey(device.id, audio.id))}
      onMute={(muted) =>
        void devices
          .command(
            {
              key: tileKey(device.id, audio.id),
              deviceId: device.id,
              capabilityId: audio.id,
              kind: "audio",
            },
            { muted },
          )
          .catch(() => undefined)
      }
    />
  );
  // Every page after its controls'.
  const after = device
    ? [
        ...(mediaProps
          ? [
              {
                id: "playing",
                label: "Playing",
                icon: Play,
                content: (
                  <MediaPlaying
                    key={`${device.id}/playing`}
                    {...mediaProps}
                    artwork={artwork?.url ?? null}
                    isArtworkMissing={isArtworkMissing}
                    onArtworkError={setFailedArtworkUrl}
                  />
                ),
              },
              // A player with power has a Remote, with its power; one
              // without has its Volume, mute and level. Either shows its
              // volume dimmed where it has none to change.
              ...(mediaProps.capability.features.power
                ? [
                    {
                      id: "remote",
                      label: "Remote",
                      icon: RemoteIcon,
                      content: (
                        <MediaRemote
                          {...mediaProps}
                          microphones={microphones}
                        />
                      ),
                    },
                  ]
                : [
                    {
                      id: "volume",
                      label: "Volume",
                      icon: Volume2,
                      content: (
                        <MediaVolume
                          key={`${device.id}/volume`}
                          {...mediaProps}
                          microphones={microphones}
                        />
                      ),
                    },
                  ]),
            ]
          : []),
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
        ...(contact
          ? [
              {
                id: "contact",
                // Named for what the household shows it as.
                label: contactPageName(contactShownAs),
                icon: contactIcon(contactShownAs, false),
                content: (
                  <ContactPage
                    key={`${device.id}/${contact.id}`}
                    device={device}
                    capability={contact}
                  />
                ),
              },
            ]
          : []),
        ...(hasReadings
          ? [
              {
                id: "readings",
                label: "Readings",
                // The light level's sun for a sensor that reads only it, as
                // its tile has.
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
                    unit={devices.places?.home.temperatureUnit ?? "celsius"}
                    // The Motion or Contact page has its battery.
                    battery={!motion && !contact}
                  />
                ),
              },
            ]
          : []),
        ...fromApps,
        ...[history, activity].flatMap((page) => page ?? []),
      ]
    : [];
  const initial =
    props.openFirstPage || !capability
      ? undefined
      : capability.kind === "button"
        ? buttonPage
          ? "apps"
          : "activity"
        : pageOf[capability.kind];
  const detailKey = `${props.openFirstPage ? "room" : "part"}/${tile?.key}`;
  const [selection, setSelection] = useState<{
    detailKey: string;
    page: string;
    tint: string | null;
  } | null>(null);
  const selected = selection?.detailKey === detailKey ? selection : null;
  const page =
    selected?.page ?? initial ?? (controlTile ? undefined : after[0]?.id);
  const tint =
    page === "playing"
      ? (artwork?.colour ?? (isArtworkMissing ? missingArtworkTint : null))
      : (selected?.tint ?? null);
  // The other pages keep the colour they had when they came into view.
  const onPageChange = (page: string) =>
    setSelection({ detailKey, page, tint });
  const detailPages = after.map((each) => ({
    ...each,
    content: (
      <ChartPageSelected.Provider value={each.id === page}>
        {each.content}
      </ChartPageSelected.Provider>
    ),
  }));

  return (
    <Overlay
      container={props.container}
      open={props.open && hasDetail}
      onClose={onClose}
      onCovering={props.onCovering}
      title={name}
      tint={tint}
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
        hasDetail &&
        (control && controlTile ? (
          <LightControls
            // Each tile's detail opens afresh, on its own page.
            key={detailKey}
            name={name}
            features={
              control.kind === "light" ? control.features : switchFeatures
            }
            state={control.state ?? { on: false }}
            disabled={controlTile.disabled}
            failures={controlTile.failures}
            onCommand={(command) =>
              void devices.command(controlTile, command).catch(() => undefined)
            }
            pages={detailPages}
            initial={initial}
            onPageChange={onPageChange}
          />
        ) : (
          <SwipePages
            key={detailKey}
            label={name}
            pages={detailPages}
            initial={initial}
            onPageChange={onPageChange}
          />
        ))}
    </Overlay>
  );
}

// Apps' pages for the device, one after the other in a column 520 px wide
// at most, each under the shell's notice while its app isn't running.
function AppPages(props: {
  pages: ReturnType<typeof devicePages>;
  initialPage?: ReturnType<typeof devicePages>[number];
  openSettings: (app: string) => void;
  openStatus: () => void;
  household: ComponentProps<typeof DeviceFrame>["household"];
  isAway: boolean;
  onEscape: () => void;
}) {
  const initial = useRef<HTMLDivElement>(null);
  const initialId = props.initialPage?.id;
  const initialApp = props.initialPage?.app.info.id;
  useEffect(() => {
    const target = initial.current;
    const column = target?.parentElement;
    const scrollArea = target?.closest("[data-slot=scroll-area]");
    if (!target || !column || !scrollArea) return;

    // Earlier frames can grow as they load. Keep the opening page in view
    // until someone starts navigating the app pages themselves.
    const show = () => {
      if (!target.closest("[inert]")) {
        target.scrollIntoView({ block: "start", inline: "nearest" });
      }
    };
    const observer = new ResizeObserver(show);
    observer.observe(column);
    show();
    const stop = () => observer.disconnect();
    const events = ["pointerdown", "wheel", "keydown"];
    for (const event of events) scrollArea.addEventListener(event, stop, true);
    return () => {
      stop();
      for (const event of events)
        scrollArea.removeEventListener(event, stop, true);
    };
  }, [initialApp, initialId]);

  return (
    <div className="flex w-[520px] max-w-full flex-col gap-8">
      {props.pages.map(({ app, id, title, device }) => (
        <div
          key={`${app.info.id}/${id}/${device.id}`}
          ref={
            id === initialId && app.info.id === initialApp ? initial : undefined
          }
          className="flex flex-col gap-3"
        >
          <AppNotice
            app={app.info}
            permissionsAre="settings"
            openSettings={() => props.openSettings(app.info.id)}
            openStatus={props.openStatus}
          />
          <WhileNotRunning app={app.info} className="flex flex-col">
            <DeviceFrame
              app={app}
              page={id}
              title={title}
              device={device}
              household={props.household}
              isAway={props.isAway}
              onEscape={props.onEscape}
            />
          </WhileNotRunning>
        </div>
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

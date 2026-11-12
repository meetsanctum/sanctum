import type {
  CapabilityInfo,
  DeviceHistory,
  DeviceInfo,
} from "@meetsanctum/app-sdk";
import { icons, SectionHeading, type Tile } from "@meetsanctum/ui-sdk";
import { useEffect, useId, useRef, useState } from "react";

import { coreJson } from "./core-fetch";
import { useWidth } from "./device-history";
import { dayMs, spansOf, type Live, type Span } from "./device-history-data";
import { tileKey } from "./device-tiles";
import { placeMotionText } from "./motion";
import { BandMarks, BandTicks } from "./motion-band";
import { motionSentence, roomSpans } from "./motion-history-data";
import type { Devices } from "./use-devices";

// Presence's overview, at the top of its page above its sensors by room:
// under "Last 24 hours", a row for each room with a motion sensor, in the
// home's order, with what the room says now and its day as a band, motion
// while any of its sensors saw it. Rooms without one are left out, and so are
// sensors in no room. A row opens its room's page.

type Occupancy = Extract<CapabilityInfo, { kind: "occupancy" }>;
type Sensor = { device: DeviceInfo; capability: Occupancy };

const minute = 60_000;
const refreshMs = 5 * minute;

const isOccupancy = (capability: CapabilityInfo): capability is Occupancy =>
  capability.kind === "occupancy";

/**
 * The last 24 hours of each sensor, by its tile's key: read when shown,
 * again for a sensor when it changes or goes offline or back, and for all
 * of them every 5 minutes, with the end moving on each minute.
 */
function useLastDay(sensors: readonly Sensor[]) {
  const [histories, setHistories] = useState<
    ReadonlyMap<string, DeviceHistory>
  >(new Map());
  const [now, setNow] = useState(() => Date.now());
  // What each sensor was when its history was last read.
  const read = useRef(new Map<string, string>());
  const wanted = JSON.stringify(
    sensors.map(({ device, capability }) => [
      device.id,
      capability.id,
      `${device.availability} ${capability.changedAt ?? ""}`,
    ]),
  );

  useEffect(() => {
    let current = true;
    const each = JSON.parse(wanted) as [string, string, string][];
    const load = async (all: boolean) => {
      const to = Date.now();
      const stale = each.filter(
        ([device, capability, version]) =>
          all || read.current.get(tileKey(device, capability)) !== version,
      );
      if (stale.length === 0) return;
      const results = await Promise.allSettled(
        stale.map(([device, capability]) =>
          coreJson<DeviceHistory>(
            `/api/history/states?${new URLSearchParams({
              device,
              capability,
              from: new Date(to - dayMs).toISOString(),
              to: new Date(to).toISOString(),
            })}`,
          ),
        ),
      );
      if (!current) return;
      const fresh = new Map<string, DeviceHistory>();
      for (const [index, result] of results.entries()) {
        if (result.status !== "fulfilled") continue;
        const [device, capability, version] = stale[index]!;
        const key = tileKey(device, capability);
        read.current.set(key, version);
        fresh.set(key, result.value);
      }
      setHistories((previous) => new Map([...previous, ...fresh]));
      setNow(Date.now());
    };
    void load(false);
    const reload = setInterval(() => void load(true), refreshMs);
    return () => {
      current = false;
      clearInterval(reload);
    };
  }, [wanted]);

  useEffect(() => {
    const tick = setInterval(() => setNow(Date.now()), minute);
    return () => clearInterval(tick);
  }, []);

  return { histories, now };
}

// What a sensor says now, carried past its last recorded change: a change
// the core broadcast before History had it shows at once.
function liveOf({ device, capability }: Sensor): Live[] {
  if (device.availability === "offline" || !capability.state) return [];
  const since = capability.changedAt ? Date.parse(capability.changedAt) : NaN;
  if (Number.isNaN(since)) return [];
  return [
    {
      availability: device.availability,
      state: capability.state as unknown as Record<string, unknown>,
      since,
    },
  ];
}

/**
 * What a room's row says now: its motion as its line does, or while none
 * of its sensors answers, what they all say ("Offline"), else "No readings".
 */
function roomStatus(tiles: readonly Tile[], now: number) {
  const motion = placeMotionText(tiles, now);
  if (motion) return motion;
  const statuses = new Set(tiles.map((tile) => tile.status));
  return statuses.size === 1 ? [...statuses][0]! : "No readings";
}

export function PresenceOverview(props: {
  devices: Devices;
  openRoom: (roomId: string) => void;
}) {
  const { devices } = props;
  const headingId = useId();
  const ticks = useWidth();
  const rooms = devices.places?.rooms ?? [];
  const placed = new Set(rooms.map((room) => room.id));
  const sensors = devices.devices.flatMap((device) =>
    device.roomId && placed.has(device.roomId)
      ? device.capabilities
          .filter(isOccupancy)
          .map((capability) => ({ device, capability }))
      : [],
  );
  const { histories, now } = useLastDay(sensors);
  const from = now - dayMs;
  const shown = rooms.flatMap((room) => {
    const own = sensors.filter((sensor) => sensor.device.roomId === room.id);
    if (own.length === 0) return [];
    const keys = new Set(
      own.map((sensor) => tileKey(sensor.device.id, sensor.capability.id)),
    );
    const tiles = devices.tiles.filter((tile) => keys.has(tile.key));
    const spans = roomSpans(
      own.map((sensor) => {
        const history = histories.get(
          tileKey(sensor.device.id, sensor.capability.id),
        );
        return history ? spansOf(history, from, now, liveOf(sensor)) : [];
      }),
      from,
      now,
    );
    return [
      {
        room,
        spans,
        status: roomStatus(tiles, now),
        active: tiles.some((tile) => !tile.disabled && tile.motion?.occupied),
      },
    ];
  });
  if (shown.length === 0) return null;

  return (
    <section
      aria-labelledby={headingId}
      className="@container/day flex shrink-0 flex-col gap-3"
    >
      <div className="flex flex-col gap-2 @lg/day:flex-row @lg/day:items-end">
        <div className="@lg/day:w-[242px] @lg/day:shrink-0">
          <SectionHeading id={headingId}>Last 24 hours</SectionHeading>
        </div>
        <div className="px-3.5 @lg/day:flex-1 @lg/day:ps-0">
          <div ref={ticks.box}>
            <BandTicks
              from={from}
              to={now}
              plot={ticks.width}
              withNow
              className="text-(--tile-secondary)"
            />
          </div>
        </div>
      </div>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {shown.map(({ room, spans, status, active }) => (
          <li key={room.id}>
            <RoomRow
              name={room.name}
              status={status}
              active={active}
              spans={spans}
              from={from}
              to={now}
              onOpen={() => props.openRoom(room.id)}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

// A room's row: frosted glass, its footprints in a circle that turns White
// while there is motion, its name and what it says now, then its band; on
// a narrow page the band goes under its name.
function RoomRow(props: {
  name: string;
  status: string;
  active: boolean;
  spans: readonly Span[];
  from: number;
  to: number;
  onOpen: () => void;
}) {
  const { spans, from, to } = props;
  const band = useWidth<HTMLSpanElement>();
  const x = (at: number) => ((at - from) / (to - from)) * band.width;
  return (
    <button
      type="button"
      aria-label={`${props.name}, ${props.status}. ${motionSentence(spans, from, to)}`}
      onClick={props.onOpen}
      className="flex w-full flex-col gap-2 rounded-lg bg-(--tile) px-3.5 py-3 text-left text-(--tile-ink) backdrop-blur-[24px] outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 @lg/day:flex-row @lg/day:items-center @lg/day:gap-3"
    >
      <span className="flex min-w-0 items-center gap-3 @lg/day:w-54 @lg/day:shrink-0">
        <span
          data-active={props.active ? "" : undefined}
          className="grid size-10 shrink-0 place-items-center rounded-full bg-(--tile-chip) data-active:bg-(--tile-on) data-active:text-(--tile-on-ink)"
        >
          <icons.Footprints aria-hidden="true" className="size-[18px]" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
          <span className="truncate text-sm font-medium">{props.name}</span>
          <span className="truncate text-[13px] font-medium text-(--tile-secondary)">
            {props.status}
          </span>
        </span>
      </span>
      <span
        ref={band.box}
        aria-hidden="true"
        className="block h-10 w-full min-w-0 @lg/day:flex-1"
      >
        <BandMarks spans={spans} x={x} plot={band.width} />
      </span>
    </button>
  );
}

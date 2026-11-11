import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { icons, type Tile } from "@meetsanctum/ui-sdk";
import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import type { OnHome } from "./dashboards";
import { homePlaces } from "./home-dashboard";
import type { Devices } from "./use-devices";

// Edit Home, from Home's ⋮ menu: each room by name, then devices with no
// room, with its devices on Home in their order and under them those that
// are not. A device's round turns − or + to take it off Home or put it
// there, and a device on Home is dragged into its place, or moved with the
// arrow keys from its grip, within its room. Everything is saved as it
// changes, so Done in the top bar is the way out. Home is the household's,
// so it is the same on every device.

// How far a finger moves before a press becomes a drag, in px.
const dragAfter = 8;

type Drag = {
  id: string;
  room: string;
  pointerId: number;
  x: number;
  y: number;
  active: boolean;
};

// A device as Edit Home shows it: its name, and what its first tile looks
// like and says.
type EditDevice = { device: DeviceInfo; tile: Tile | undefined };

export function EditHome(props: { devices: Devices; home: OnHome }) {
  const { devices, home } = props;
  // The device a drag moves and its room's order so far, until it ends.
  const [moving, setMoving] = useState<{ id: string; ids: string[] } | null>(
    null,
  );
  const drag = useRef<Drag | null>(null);
  const tiles = useRef(new Map<string, HTMLDivElement>());
  const grips = useRef(new Map<string, HTMLButtonElement>());
  // The device the arrow keys just moved, whose grip keeps focus though
  // its tile moved.
  const refocus = useRef<string | null>(null);
  const [announcement, setAnnouncement] = useState("");

  useLayoutEffect(() => {
    const id = refocus.current;
    if (!id) return;
    refocus.current = null;
    const grip = grips.current.get(id);
    if (grip && document.activeElement !== grip) grip.focus();
  });

  const byId = new Map(devices.devices.map((device) => [device.id, device]));
  const onHome = new Set(home.devices ?? []);
  const rooms = new Set(devices.places?.rooms.map((room) => room.id));
  // A device in a room the home no longer has is in none, as its tiles are.
  const roomOf = (device: DeviceInfo) =>
    device.roomId !== null && rooms.has(device.roomId) ? device.roomId : null;
  const firstTile = (id: string) =>
    devices.tiles.find((tile) => tile.deviceId === id);
  const places = homePlaces(devices, home.devices).flatMap((place) => {
    const shownOnHome = (home.devices ?? []).flatMap((id): EditDevice[] => {
      const device = byId.get(id);
      return device && roomOf(device) === (place.room?.id ?? null)
        ? [{ device, tile: firstTile(id) }]
        : [];
    });
    const others = devices.devices
      .filter(
        (device) =>
          roomOf(device) === (place.room?.id ?? null) && !onHome.has(device.id),
      )
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((device) => ({ device, tile: firstTile(device.id) }));
    return shownOnHome.length + others.length > 0
      ? [{ ...place, shownOnHome, others }]
      : [];
  });

  const order = (ids: string[], before: string[]) => {
    if (ids.join() === before.join()) return;
    void home.order(ids).catch(() => undefined);
  };
  const move = (place: (typeof places)[number], id: string, by: number) => {
    const before = place.shownOnHome.map((each) => each.device.id);
    const ids = [...before];
    const from = ids.indexOf(id);
    const to = Math.max(0, Math.min(ids.length - 1, from + by));
    if (from === to) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    refocus.current = id;
    setAnnouncement(
      `${byId.get(id)?.name ?? "The device"}, ${to + 1} of ${ids.length}`,
    );
    order(ids, before);
  };

  const dragHandlers = (place: (typeof places)[number], id: string) => ({
    onPointerDown(event: PointerEvent<HTMLDivElement>) {
      if (event.isPrimary === false || event.button !== 0) return;
      drag.current = {
        id,
        room: place.id,
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        active: false,
      };
    },
    onPointerMove(event: PointerEvent<HTMLDivElement>) {
      const at = drag.current;
      if (!at || at.pointerId !== event.pointerId || at.room !== place.id)
        return;
      if (!at.active) {
        if (
          Math.hypot(event.clientX - at.x, event.clientY - at.y) < dragAfter
        ) {
          return;
        }
        at.active = true;
        tiles.current.get(at.id)?.setPointerCapture?.(event.pointerId);
        setMoving({
          id: at.id,
          ids: place.shownOnHome.map((each) => each.device.id),
        });
      }
      // The tile under the pointer, in the same room, makes room for the
      // dragged one.
      for (const other of place.shownOnHome) {
        const otherId = other.device.id;
        if (otherId === at.id) continue;
        const box = tiles.current.get(otherId)?.getBoundingClientRect();
        if (
          box &&
          event.clientX >= box.left &&
          event.clientX <= box.right &&
          event.clientY >= box.top &&
          event.clientY <= box.bottom
        ) {
          setMoving((current) => {
            if (!current) return current;
            const ids = current.ids.filter((each) => each !== at.id);
            ids.splice(current.ids.indexOf(otherId), 0, at.id);
            return { ...current, ids };
          });
          break;
        }
      }
    },
    onPointerUp(event: PointerEvent<HTMLDivElement>) {
      const at = drag.current;
      if (!at || at.pointerId !== event.pointerId) return;
      drag.current = null;
      if (!at.active) return;
      if (moving) {
        order(
          moving.ids,
          place.shownOnHome.map((each) => each.device.id),
        );
      }
      setMoving(null);
    },
    onPointerCancel(event: PointerEvent<HTMLDivElement>) {
      if (drag.current?.pointerId !== event.pointerId) return;
      drag.current = null;
      setMoving(null);
    },
  });

  return (
    <>
      <p
        id="edit-home-hint"
        className="m-0 max-w-[640px] shrink-0 text-[13px] leading-[18px] font-medium"
      >
        Choose what each room shows on {home.name} after its moods, and in which
        order: drag a tile, or move it with the arrow keys. Changes are saved as
        you make them.
      </p>
      {places.map((place) => {
        const headingId = `edit-${place.id}`;
        const shown =
          moving &&
          place.shownOnHome.some((each) => each.device.id === moving.id)
            ? moving.ids.flatMap(
                (id) =>
                  place.shownOnHome.find((each) => each.device.id === id) ?? [],
              )
            : place.shownOnHome;
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
              {place.name}
            </h2>
            {shown.length > 0 ? (
              <div
                role="group"
                aria-label={`${place.name} on ${home.name}`}
                className="grid auto-rows-(--cell) grid-cols-[repeat(auto-fill,var(--cell))] gap-(--cell-gap)"
              >
                {shown.map(({ device, tile }) => (
                  <EditTile
                    key={device.id}
                    device={device}
                    tile={tile}
                    onHome
                    homeName={home.name}
                    dragging={moving?.id === device.id}
                    tileRef={(element) => {
                      if (element) tiles.current.set(device.id, element);
                      else tiles.current.delete(device.id);
                    }}
                    gripRef={(element) => {
                      if (element) grips.current.set(device.id, element);
                      else grips.current.delete(device.id);
                    }}
                    onChange={() =>
                      void home.remove(device.id).catch(() => undefined)
                    }
                    onKeyDown={(event) => {
                      const by =
                        event.key === "ArrowLeft" || event.key === "ArrowUp"
                          ? -1
                          : event.key === "ArrowRight" ||
                              event.key === "ArrowDown"
                            ? 1
                            : 0;
                      if (by === 0) return;
                      event.preventDefault();
                      move(place, device.id, by);
                    }}
                    {...dragHandlers(place, device.id)}
                  />
                ))}
              </div>
            ) : (
              <p className="m-0 text-[13px] leading-[18px] font-medium">
                Nothing {place.room ? `in ${place.name}` : "here"} is on{" "}
                {home.name}.
              </p>
            )}
            {place.others.length > 0 && (
              <>
                {shown.length > 0 && (
                  <p className="m-0 mt-1 text-[13px] leading-[18px] font-medium">
                    Not on {home.name}
                  </p>
                )}
                <div
                  role="group"
                  aria-label={`${place.name}, not on ${home.name}`}
                  className="grid auto-rows-(--cell) grid-cols-[repeat(auto-fill,var(--cell))] gap-(--cell-gap)"
                >
                  {place.others.map(({ device, tile }) => (
                    <EditTile
                      key={device.id}
                      device={device}
                      tile={tile}
                      onHome={false}
                      homeName={home.name}
                      onChange={() =>
                        void home.add(device.id).catch(() => undefined)
                      }
                    />
                  ))}
                </div>
              </>
            )}
          </section>
        );
      })}
      <p role="status" className="sr-only">
        {announcement}
      </p>
    </>
  );
}

// A device in Edit Home: its round takes it off Home or puts it there, and
// one on Home has a grip, which the arrow keys move it with, and is
// dragged anywhere on it. It looks as its first tile does on Home, a lit
// light in its colour at its brightness; one not on Home is fainter.
function EditTile(props: {
  device: DeviceInfo;
  tile: Tile | undefined;
  onHome: boolean;
  homeName: string;
  dragging?: boolean;
  tileRef?: (element: HTMLDivElement | null) => void;
  gripRef?: (element: HTMLButtonElement | null) => void;
  onChange: () => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp?: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerCancel?: (event: PointerEvent<HTMLDivElement>) => void;
}) {
  const { device, tile } = props;
  const look = props.onHome ? (tile?.look ?? "off") : "off";
  const level =
    look === "lit" && tile?.dims && tile.on ? tile.brightness : undefined;
  return (
    <div
      ref={props.tileRef}
      data-look={look}
      data-off-home={props.onHome ? undefined : ""}
      data-dragging={props.dragging ? "" : undefined}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerCancel}
      style={
        tile?.colour
          ? ({ "--tile-colour": tile.colour } as CSSProperties)
          : undefined
      }
      className="group relative col-span-3 flex min-w-0 items-center overflow-hidden rounded-lg bg-(--tile) py-3 ps-3.5 pe-2 text-(--tile-ink) backdrop-blur-[24px] transition-[opacity,transform] duration-150 select-none data-dragging:scale-[1.03] data-dragging:opacity-80 data-off-home:bg-(--tile)/50 data-[look=lit]:bg-(--tile-colour) data-[look=lit]:text-(--carbon) data-[look=on]:bg-(--tile-on) data-[look=on]:text-(--tile-on-ink) motion-reduce:transition-none [touch-action:none] data-off-home:[touch-action:auto]"
    >
      {level !== undefined && (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 origin-right bg-white/50"
          style={{ transform: `scaleX(${(100 - level) / 100})` }}
        />
      )}
      <button
        type="button"
        aria-label={
          props.onHome
            ? `Remove ${device.name} from ${props.homeName}`
            : `Add ${device.name} to ${props.homeName}`
        }
        onClick={props.onChange}
        className="relative me-2.5 grid size-10 shrink-0 place-items-center rounded-full bg-(--tile-chip) outline-none hover:ring-2 hover:ring-current/35 focus-visible:ring-3 focus-visible:ring-ring/50 group-data-[look=lit]:bg-white/55 group-data-[look=on]:bg-(--tile-on-ink)/8"
      >
        {props.onHome ? (
          <icons.Minus aria-hidden="true" className="size-4" />
        ) : (
          <icons.Plus aria-hidden="true" className="size-4" />
        )}
      </button>
      <span className="relative flex min-w-0 flex-1 flex-col gap-px leading-tight">
        <span title={device.name} className="truncate text-sm font-medium">
          {device.name}
        </span>
        {tile && (
          <span className="truncate text-[13px] font-medium text-(--tile-secondary) group-data-[look=lit]:text-(--carbon)/65 group-data-[look=on]:text-(--tile-on-ink)/65">
            {tile.status}
          </span>
        )}
      </span>
      {props.onHome && (
        <button
          ref={props.gripRef}
          type="button"
          aria-label={`Move ${device.name}`}
          aria-describedby="edit-home-hint"
          onKeyDown={props.onKeyDown}
          className="relative -me-1.5 grid h-10 w-6 shrink-0 cursor-grab place-items-center rounded-xs opacity-65 outline-none focus-visible:opacity-100 focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <icons.GripVertical aria-hidden="true" className="size-4" />
        </button>
      )}
    </div>
  );
}

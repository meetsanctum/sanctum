import {
  CircleDot,
  Footprints,
  Lightbulb,
  LightbulbOff,
  Plug,
  Sun,
  Thermometer,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent,
} from "react";

import { showFailed } from "./show-failed";
import type { Tile } from "./tiles";
import { useThrottledSend } from "./use-throttled-send";

// How far a finger moves before a press becomes a drag, in px.
const dragAfter = 8;
// How long a dragged level shows before the light's own state takes over
// again, if no answer changes it first, in ms.
const holdPreview = 3_000;

const clamp = (level: number) => Math.max(0, Math.min(100, Math.round(level)));

type Drag = {
  pointerId: number;
  x: number;
  y: number;
  from: number;
  level: number;
  width: number;
  active: boolean;
};

// The level a drag has reached where the finger is: the tile's whole width
// is 100%.
const levelAt = (at: Drag, clientX: number) =>
  clamp(at.from + ((clientX - at.x) / at.width) * 100);

// A light or switch on the grid: frosted glass when off; on, a switch turns
// white and a light takes its own colour, with Carbon text on both. Tapping
// switches it; where it also opens a detail, as the shell's tiles do, its
// round icon switches it and the rest opens the detail, offline too.
// Dragging across a light that dims sets its brightness, which the lit part
// of the tile shows; the rest is washed out. The level goes out once the
// finger lifts: the core remembers the last level a light was asked for, so
// levels a drag passed through would otherwise be what a drag ending in off
// comes back at. Keyboards and screen readers get the same as a slider
// beside the tile's button. A remote's tile switches nothing: it turns white
// with its press for a moment, and tapping anywhere opens its detail, as it
// does a sensor's, which shows its readings, and a motion sensor's, white
// while it sees motion.
export function DeviceTile(props: {
  tile: Tile;
  onToggle: (tile: Tile) => void;
  onDim: (tile: Tile, brightness: number) => void;
  /** Opens the device's detail, which its icon then leaves to switching. */
  onOpen?: (tile: Tile) => void;
}) {
  const { tile, onOpen } = props;
  const [preview, setPreview] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef<Drag | null>(null);
  const dragged = useRef(false);
  const clearing = useRef<ReturnType<typeof setTimeout>>(undefined);
  const surface = useRef<HTMLButtonElement>(null);
  const wash = useRef<HTMLSpanElement>(null);
  const canDim = tile.dims && !tile.disabled;
  const dimmer = useThrottledSend<number>(
    (level) => props.onDim(tile, level),
    canDim,
  );

  useEffect(() => {
    if (!canDim) {
      drag.current = null;
      setDragging(false);
      setPreview(null);
      clearTimeout(clearing.current);
    }
  }, [canDim]);

  // The light's own state takes over again once it changes, unless a drag
  // is still going.
  useEffect(() => {
    if (!drag.current) setPreview(null);
  }, [tile.on, tile.brightness]);
  useEffect(() => () => clearTimeout(clearing.current), []);

  // A failed command leaves the light as it was, so a dragged or stepped
  // level it was holding goes too. Only failures from while the tile is
  // shown show: a page opened later starts calm.
  const failures = useRef(tile.failures ?? 0);
  useEffect(() => {
    if ((tile.failures ?? 0) <= failures.current) return;
    failures.current = tile.failures ?? 0;
    if (!drag.current) {
      clearTimeout(clearing.current);
      setPreview(null);
    }
    showFailed(surface.current, wash.current);
  }, [tile.failures]);

  const show = (level: number) => {
    clearTimeout(clearing.current);
    setPreview(level);
  };
  // The dragged or stepped level shows until the core answers.
  const hold = () => {
    clearTimeout(clearing.current);
    clearing.current = setTimeout(() => setPreview(null), holdPreview);
  };

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    // A second finger neither starts a drag nor takes over the first one's.
    if (event.isPrimary === false) return;
    dragged.current = false;
    if (!canDim || event.button !== 0) return;
    const from = tile.on ? (tile.brightness ?? 0) : 0;
    drag.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      from,
      level: from,
      // The icon starts drags too, across the whole tile.
      width: surface.current?.offsetWidth || 1,
      active: false,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const at = drag.current;
    if (!at || at.pointerId !== event.pointerId) return;
    const across = event.clientX - at.x;
    const down = event.clientY - at.y;
    if (!at.active) {
      // A move that is mostly up or down scrolls the page instead, and is
      // not a tap either.
      if (Math.abs(down) > dragAfter && Math.abs(down) > Math.abs(across)) {
        drag.current = null;
        dragged.current = true;
        return;
      }
      if (Math.abs(across) < dragAfter) return;
      at.active = true;
      setDragging(true);
      event.currentTarget.setPointerCapture?.(event.pointerId);
    }
    at.level = levelAt(at, event.clientX);
    show(at.level);
  };
  const onPointerEnd = (event: PointerEvent<HTMLButtonElement>) => {
    const at = drag.current;
    if (!at || at.pointerId !== event.pointerId) return;
    drag.current = null;
    if (at.active) {
      dragged.current = true;
      setDragging(false);
      if (canDim && at.level !== at.from) props.onDim(tile, at.level);
      hold();
    }
  };
  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    // A browser can release a finger past the last move it reported.
    const at = drag.current;
    if (!at || at.pointerId !== event.pointerId) return;
    if (at.active) {
      at.level = levelAt(at, event.clientX);
      show(at.level);
    }
    onPointerEnd(event);
  };
  const onPointerCancel = (event: PointerEvent<HTMLButtonElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    // The browser took over the gesture, for example to scroll. Discard
    // its preview before capture is released, without changing the light.
    drag.current = null;
    dragged.current = true;
    setDragging(false);
    clearTimeout(clearing.current);
    setPreview(null);
  };

  // A drag or a swipe that ends over the tile is not a tap. A click no
  // pointer made (detail 0), as from a key, always is.
  const tapped = (event: MouseEvent) => {
    const moved = dragged.current;
    dragged.current = false;
    return !moved || event.detail === 0;
  };
  const gestures = {
    onPointerDown,
    onPointerMove,
    onPointerLeave: (event: PointerEvent<HTMLButtonElement>) => {
      // Before capture starts, a mouse can leave and release elsewhere.
      if (drag.current?.pointerId === event.pointerId && !drag.current.active) {
        drag.current = null;
      }
    },
    onPointerUp,
    onPointerCancel,
    // A release the tile does not hear, such as outside the window, still
    // ends the drag.
    onLostPointerCapture: onPointerEnd,
  };

  const level = preview ?? (tile.on ? tile.brightness : undefined);
  const on = preview === null ? tile.on : preview > 0;
  const look =
    preview === null ? tile.look : tile.kind === "light" && on ? "lit" : "off";
  const status =
    preview === null ? tile.status : preview > 0 ? `${preview}%` : "Off";
  const switches = tile.kind === "light" || tile.kind === "switch";
  // The round icon switches it only where the rest opens the detail.
  const iconSwitches = onOpen !== undefined && switches;
  const Icon =
    tile.kind === "button"
      ? CircleDot
      : tile.kind === "sensor"
        ? // A sensor that only reads the light level, such as a motion
          // sensor's, has the light level's sun.
          tile.measures?.every((measure) => measure === "illuminance")
          ? Sun
          : Thermometer
        : tile.kind === "occupancy"
          ? Footprints
          : tile.kind === "switch"
            ? Plug
            : on
              ? Lightbulb
              : LightbulbOff;
  const iconLook =
    "grid size-10 shrink-0 place-items-center rounded-full bg-(--tile-chip) data-[look=lit]:bg-white/55 data-[look=on]:bg-(--tile-on-ink)/8";

  return (
    <div className="relative col-span-3 flex min-w-0 rounded-lg has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/50">
      <button
        ref={surface}
        type="button"
        aria-pressed={onOpen || !switches ? undefined : on}
        aria-haspopup={onOpen ? "dialog" : undefined}
        aria-label={onOpen ? `${tile.name}, ${status}` : undefined}
        disabled={!onOpen && (tile.disabled || !switches)}
        data-look={look}
        data-dragging={dragging ? "" : undefined}
        data-offline={tile.disabled ? "" : undefined}
        {...gestures}
        onClick={(event) => {
          if (!tapped(event.nativeEvent)) return;
          if (onOpen) onOpen(tile);
          else if (switches) props.onToggle(tile);
        }}
        style={
          tile.colour
            ? ({ "--tile-colour": tile.colour } as CSSProperties)
            : undefined
        }
        className="group relative flex min-w-0 flex-1 items-center gap-3 overflow-hidden rounded-lg bg-(--tile) px-3.5 py-3 text-left text-(--tile-ink) backdrop-blur-[24px] outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 data-offline:opacity-50 data-[look=lit]:bg-(--tile-colour) data-[look=lit]:text-(--carbon) data-[look=on]:bg-(--tile-on) data-[look=on]:text-(--tile-on-ink) [touch-action:pan-y]"
      >
        {canDim && look === "lit" && level !== undefined && (
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 origin-right bg-white/50 transition-transform duration-150 group-data-dragging:transition-none motion-reduce:transition-none"
            style={{ transform: `scaleX(${(100 - level) / 100})` }}
          />
        )}
        <span
          ref={wash}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-(--danger) opacity-0"
        />
        {iconSwitches ? (
          // Room for the icon's own button, which sits over it.
          <span aria-hidden="true" className="size-10 shrink-0" />
        ) : (
          <span data-look={look} className={`relative ${iconLook}`}>
            <Icon aria-hidden="true" className="size-[18px]" />
          </span>
        )}
        <span className="relative flex min-w-0 flex-col gap-px leading-tight">
          <span className="truncate text-sm font-medium">{tile.name}</span>
          <span className="truncate text-[13px] font-medium text-(--tile-secondary) group-data-[look=lit]:text-(--carbon)/65 group-data-[look=on]:text-(--tile-on-ink)/65">
            {status}
          </span>
        </span>
      </button>
      {iconSwitches && (
        <button
          type="button"
          aria-label={tile.name}
          aria-pressed={on}
          disabled={tile.disabled}
          data-look={look}
          {...gestures}
          onClick={(event) => {
            if (tapped(event.nativeEvent)) props.onToggle(tile);
          }}
          className={`absolute top-1/2 left-3.5 -translate-y-1/2 text-(--tile-ink) outline-none select-none hover:ring-2 hover:ring-current/35 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 disabled:hover:ring-0 data-[look=lit]:text-(--carbon) data-[look=on]:text-(--tile-on-ink) [touch-action:pan-y] ${iconLook}`}
        >
          <Icon aria-hidden="true" className="size-[18px]" />
        </button>
      )}
      {canDim && (
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={level ?? 0}
          aria-label={`${tile.name} brightness`}
          aria-valuetext={on ? `${level ?? 0}%` : "Off"}
          onChange={(event) => {
            const brightness = Number(event.target.value);
            show(brightness);
            dimmer.send(brightness);
            hold();
          }}
          onBlur={() => {
            dimmer.flush();
            hold();
          }}
          className="sr-only"
        />
      )}
    </div>
  );
}

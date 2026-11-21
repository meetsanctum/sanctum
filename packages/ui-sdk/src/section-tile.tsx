import type { LucideIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { Button } from "./components/ui/button";
import { showFailed } from "./show-failed";

/**
 * A tile in a room's row or an app's own page, such as a mood's: frosted
 * glass, White while active, its icon in a circle and its name, with a
 * status under it if it has one. With `iconOnly` it is one cell square with
 * its icon alone, and says its name to a screen reader and on hover. With
 * `chip` it is a chip, 36 px high, its icon and its name in a line, such as
 * a room's lights button or Natural light's. A failed tap shows on it as on
 * a device's tile.
 */
export function SectionTile(props: {
  icon: LucideIcon;
  name: string;
  status?: ReactNode;
  disabled?: boolean;
  /** Whether it is active now, for a tile that does something when pressed. */
  active?: boolean;
  /**
   * White without being a pressed button, for one whose name says what it
   * does, such as a room's switch, "Turn off".
   */
  lit?: boolean;
  /** One cell, its icon alone. */
  iconOnly?: boolean;
  /** A chip, its icon and its name in a line. */
  chip?: boolean;
  label?: string;
  editing?: boolean;
  dragging?: boolean;
  /** How many taps on it have failed here, so it shows each. */
  failures?: number;
  children?: ReactNode;
  tileRef?: (element: HTMLButtonElement | null) => void;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  onPointerDown?: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerMove?: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerUp?: (event: PointerEvent<HTMLButtonElement>) => void;
  onPointerCancel?: (event: PointerEvent<HTMLButtonElement>) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const Icon = props.icon;
  const surface = useRef<HTMLButtonElement | null>(null);
  const wash = useRef<HTMLSpanElement>(null);
  // Only failures from while the tile is shown show.
  const failures = useRef(props.failures ?? 0);
  useEffect(() => {
    if ((props.failures ?? 0) <= failures.current) return;
    failures.current = props.failures ?? 0;
    showFailed(surface.current, wash.current);
  }, [props.failures]);
  const { tileRef } = props;
  // A tile with its icon alone still has its name, to be read and hovered.
  const said = props.iconOnly ? (props.label ?? props.name) : props.label;
  const buttonProps = {
    ref: (element: HTMLButtonElement | null) => {
      surface.current = element;
      tileRef?.(element);
    },
    type: "button" as const,
    "aria-label": said,
    "aria-pressed": props.active,
    disabled: props.disabled,
    "data-editing": props.editing ? "" : undefined,
    "data-dragging": props.dragging ? "" : undefined,
    onClick: props.onClick,
    onPointerDown: props.onPointerDown,
    onPointerMove: props.onPointerMove,
    onPointerUp: props.onPointerUp,
    onPointerCancel: props.onPointerCancel,
    onKeyDown: props.onKeyDown,
  };
  const failureWash = (
    <span
      ref={wash}
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 rounded-[inherit] bg-(--danger) opacity-0"
    />
  );
  if (props.chip && !props.iconOnly) {
    return (
      <Button
        {...buttonProps}
        variant="glass"
        size="chip"
        data-on={props.lit ? "" : undefined}
        title={props.label ?? props.name}
        className="relative max-w-full self-start"
      >
        {failureWash}
        <Icon
          aria-hidden="true"
          data-icon="inline-start"
          className="relative size-[18px]"
        />
        {/* Its label stays available on hover while the chip is disabled. */}
        <span className="pointer-events-auto relative min-w-0 truncate">
          {props.name}
        </span>
        {props.children}
      </Button>
    );
  }
  return (
    <button
      {...buttonProps}
      title={props.iconOnly ? said : undefined}
      data-look={props.active || props.lit ? "on" : "off"}
      className={`${props.iconOnly ? "col-span-1 justify-center" : "col-span-3 gap-3 px-3.5 py-3"} group relative flex min-w-0 items-center overflow-hidden rounded-lg bg-(--tile) text-left text-(--tile-ink) backdrop-blur-[24px] transition-[opacity,transform] duration-150 outline-none select-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50 data-dragging:scale-[1.03] data-dragging:opacity-80 data-editing:[touch-action:none] data-[look=on]:bg-(--tile-on) data-[look=on]:text-(--tile-on-ink) motion-reduce:transition-none [touch-action:pan-y]`}
    >
      {failureWash}
      {props.iconOnly ? (
        <Icon aria-hidden="true" className="relative size-[22px]" />
      ) : (
        <>
          <span className="relative grid size-10 shrink-0 place-items-center rounded-full bg-(--tile-chip) group-data-[look=on]:bg-(--tile-on-ink)/8">
            <Icon aria-hidden="true" className="size-[18px]" />
          </span>
          <span className="relative flex min-w-0 flex-1 flex-col gap-px leading-tight">
            <span className="truncate text-sm font-medium">{props.name}</span>
            {props.status && (
              <span className="truncate text-[13px] font-medium text-(--tile-secondary) group-data-[look=on]:text-(--tile-on-ink)/65">
                {props.status}
              </span>
            )}
          </span>
        </>
      )}
      {props.children}
    </button>
  );
}

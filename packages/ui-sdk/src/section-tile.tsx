import type { LucideIcon } from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { Button } from "./components/ui/button";
import { useShowFailed } from "./show-failed";

/**
 * A tile in a room's row or an app's own page, such as a mood's: frosted
 * glass, White while active, its icon in a circle and its name, with a
 * status under it if it has one; one in a line rather than a tile is a
 * SectionButton. A failed tap shows on it as on a device's tile.
 */
export function SectionTile(props: {
  icon: LucideIcon;
  name: string;
  status?: ReactNode;
  disabled?: boolean;
  /** Whether it is active now, for a tile that does something when pressed. */
  active?: boolean;
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
  const { surface, wash } = useShowFailed(props.failures);
  const { tileRef } = props;
  return (
    <Button
      ref={(element) => {
        surface.current = element;
        tileRef?.(element);
      }}
      type="button"
      variant="section-tile"
      className="col-span-3"
      aria-label={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      data-look={props.active ? "on" : "off"}
      data-editing={props.editing ? "" : undefined}
      data-dragging={props.dragging ? "" : undefined}
      onClick={props.onClick}
      onPointerDown={props.onPointerDown}
      onPointerMove={props.onPointerMove}
      onPointerUp={props.onPointerUp}
      onPointerCancel={props.onPointerCancel}
      onKeyDown={props.onKeyDown}
    >
      <span
        ref={wash}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-(--danger) opacity-0"
      />
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
      {props.children}
    </Button>
  );
}

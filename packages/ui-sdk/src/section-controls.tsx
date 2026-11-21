import type { LucideIcon } from "lucide-react";
import {
  useEffect,
  useRef,
  type ComponentProps,
  type KeyboardEvent,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { Button } from "./components/ui/button";
import { showFailed } from "./show-failed";

function useSectionFailure(count = 0) {
  const surface = useRef<HTMLButtonElement | null>(null);
  const wash = useRef<HTMLSpanElement>(null);
  // Only failures from while the control is shown show.
  const lastCount = useRef(count);
  useEffect(() => {
    if (count <= lastCount.current) return;
    lastCount.current = count;
    showFailed(surface.current, wash.current);
  }, [count]);
  return {
    surface,
    failureWash: (
      <span
        ref={wash}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-[inherit] bg-(--danger) opacity-0"
      />
    ),
  };
}

function SectionChip(props: {
  icon: LucideIcon;
  name: string;
  isRoom: boolean;
  lit?: boolean;
  buttonProps: ComponentProps<"button">;
  failureWash: ReactNode;
  children?: ReactNode;
}) {
  const { icon: Icon, isRoom, buttonProps } = props;
  return (
    <Button
      {...buttonProps}
      type={isRoom ? "button" : undefined}
      variant="glass"
      size="chip"
      data-on={props.lit ? "" : undefined}
      title={isRoom ? (buttonProps["aria-label"] ?? props.name) : undefined}
      className={isRoom ? "relative max-w-full self-start" : "relative"}
    >
      {props.failureWash}
      <Icon
        aria-hidden="true"
        data-icon="inline-start"
        className={isRoom ? "relative size-[18px]" : "relative"}
      />
      {/* A room chip's label stays available on hover while disabled. */}
      <span
        className={
          isRoom ? "pointer-events-auto relative min-w-0 truncate" : "relative"
        }
      >
        {props.name}
      </span>
      {props.children}
    </Button>
  );
}

/**
 * A small button with a section tile's icon and name, for a page that wants
 * one in a line rather than a tile, such as a room's lights button and
 * Natural light's beside it: frosted glass, White and pressed while active,
 * or White without being pressed while lit. A failed tap shows on it as on
 * a tile.
 */
export function SectionButton(props: {
  icon: LucideIcon;
  name: string;
  /** What it is called where several rooms' buttons are in reach. */
  label?: string;
  /**
   * Room chips fit the row, show their full label on hover and never submit
   * forms. Defaults to inline.
   */
  layout?: "inline" | "room";
  /** Whether it is active now, which it says as a pressed button. */
  active?: boolean;
  /**
   * White without being a pressed button, for one whose name says what it
   * does, such as a room's lights button, "Turn off lights".
   */
  lit?: boolean;
  disabled?: boolean;
  /** How many taps on it have failed here, so it shows each. */
  failures?: number;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const { surface, failureWash } = useSectionFailure(props.failures);
  return (
    <SectionChip
      icon={props.icon}
      name={props.name}
      isRoom={props.layout === "room"}
      lit={props.lit}
      buttonProps={{
        ref: surface,
        "aria-label": props.label,
        "aria-pressed": props.active,
        disabled: props.disabled,
        onClick: props.onClick,
      }}
      failureWash={failureWash}
    />
  );
}

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
  const { surface, failureWash } = useSectionFailure(props.failures);
  const { tileRef } = props;
  // A tile with its icon alone still has its name, to be read and hovered.
  const said = props.iconOnly ? (props.label ?? props.name) : props.label;
  const buttonProps = {
    ref: (element: HTMLButtonElement | null) => {
      surface.current = element;
      tileRef?.(element);
    },
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
  if (props.chip && !props.iconOnly) {
    return (
      <SectionChip
        icon={Icon}
        name={props.name}
        isRoom
        lit={props.lit}
        buttonProps={buttonProps}
        failureWash={failureWash}
      >
        {props.children}
      </SectionChip>
    );
  }
  return (
    <button
      {...buttonProps}
      type="button"
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

import type { LucideIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { SectionTileSurface } from "./section-tile";

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
  return (
    <SectionTileSurface
      chip
      isInlineChip={props.layout !== "room"}
      icon={props.icon}
      name={props.name}
      label={props.label}
      active={props.active}
      lit={props.lit}
      disabled={props.disabled}
      failures={props.failures}
      onClick={props.onClick}
    />
  );
}

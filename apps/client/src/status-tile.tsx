import type { LucideIcon } from "@meetsanctum/ui-sdk";
import { memo } from "react";

import { sameData } from "./same-data";

// A status tile, one look wherever a category's state is summed up: Home's
// status, which opens each category, the top of a category's page, which
// only tells, and Lights' card on both (lights-card.tsx). It is frosted
// glass a cell high, with the icon in the category's colour beside its
// name over what it says now, and as wide as its words need, at least two
// cells or half a phone's line, so none is cut. Tiles sit in one line that
// scrolls sideways where they don't fit. A tile stays frosted whatever it
// says: on these rows White is only for a switch that is on.

/**
 * A status tile's outer frame, shared by whole and segmented tiles. It
 * grows with its words and has room for at least two cells or half a phone's line.
 * Its hairline edge is drawn over what it holds, so a segmented tile's
 * halves, which fill it, don't hide it.
 */
export const statusTileFrame =
  "min-w-[calc(var(--cell)*2+var(--cell-gap))] max-sm:min-w-[calc(50%-var(--cell-gap)/2)] flex h-(--cell) w-max shrink-0 rounded-lg frosted relative after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:shadow-[inset_0_0_0_1px_var(--glass-line)]";

/** A whole status tile's box, on what holds its icon and words. */
export const statusTile = `${statusTileFrame} items-center gap-2.5 bg-(--tile) px-3.5 py-3 text-left text-(--tile-ink)`;

/**
 * The line of status tiles, scrolling sideways where they don't fit, with
 * the fade of edge-fade.ts. Its padding keeps a focus ring in what the
 * scroll shows.
 */
export const statusRow =
  "-m-1 flex shrink-0 gap-(--cell-gap) overflow-x-auto p-1 [scrollbar-width:none]";

/** A status tile's icon and words: its name over what it says now. */
export const StatusTileWords = memo(function StatusTileWords(props: {
  icon: LucideIcon;
  colour: string;
  title: string;
  /** What it says now, such as "2 open" or "19.5–21.5°". */
  value: string;
  /** The value as a screen reader says it, where that differs: "19.5 to 21.5°". */
  spoken?: string;
  /** What there is to say beside it, such as "1 not known". */
  note?: string | null;
}) {
  return (
    <>
      <props.icon
        aria-hidden="true"
        className="size-[18px] shrink-0"
        style={{ color: props.colour }}
      />
      <span className="flex flex-col whitespace-nowrap">
        <span className="text-[13px] leading-[18px] font-medium text-(--tile-secondary)">
          {props.title}
        </span>
        {/* A pause between its lines, which a screen reader runs together. */}
        <span className="sr-only">, {props.spoken}</span>
        <span className="text-[15px] leading-5 font-medium tabular-nums">
          <span aria-hidden={props.spoken ? true : undefined}>
            {props.value}
          </span>
          {props.note && (
            <>
              <span className="sr-only">, </span>
              <span aria-hidden="true" className="text-(--tile-secondary)">
                {" · "}
              </span>
              <span className="text-(--tile-secondary)">{props.note}</span>
            </>
          )}
        </span>
      </span>
    </>
  );
}, sameData);

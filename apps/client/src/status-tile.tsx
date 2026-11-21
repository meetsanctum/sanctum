import type { LucideIcon } from "@meetsanctum/ui-sdk";

// A status tile, one look wherever a category's state is summed up: Home's
// status, which opens each category, the top of a category's page, which
// only tells, and Lights' card on both (lights-card.tsx). It is frosted
// glass a cell high, with the icon in the category's colour beside its
// name over what it says now, and as wide as its words need, at least two
// cells or half a phone's line, so none is cut. Tiles sit in one line that
// scrolls sideways where they don't fit. A tile stays frosted whatever it
// says: on these rows White is only for a switch that is on.

/**
 * A status tile's least width: two cells, or half a phone's line. It grows
 * with its words, so none is cut.
 */
export const statusTileWidth =
  "min-w-[calc(var(--cell)*2+var(--cell-gap))] max-sm:min-w-[calc(50%-var(--cell-gap)/2)]";

/** A whole status tile's box, on what holds its icon and words. */
export const statusTile = `${statusTileWidth} flex h-(--cell) w-max shrink-0 items-center gap-2.5 rounded-lg bg-(--tile) px-3.5 py-3 text-left text-(--tile-ink) backdrop-blur-[24px]`;

/**
 * The line of status tiles, scrolling sideways where they don't fit, with
 * the fade of edge-fade.ts. Its padding keeps a focus ring in what the
 * scroll shows.
 */
export const statusRow =
  "-m-1 flex shrink-0 gap-(--cell-gap) overflow-x-auto p-1 [scrollbar-width:none]";

/** A status tile's icon and words: its name over what it says now. */
export function StatusTileWords(props: {
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
}

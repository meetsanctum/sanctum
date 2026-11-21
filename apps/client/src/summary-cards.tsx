import type { LucideIcon } from "@meetsanctum/ui-sdk";

// What a category's page opens with: a card for each type of thing the
// category sums up, with the type's icon and name above what it says now,
// large, and a line under it where there is more to say. A card is White
// while what it counts is open or on, as its tiles are, and frosted glass
// otherwise, so what needs a look stands out before the words are read. It
// is as wide as a tile and as tall as its words, and only tells: the tiles
// below open each device.

/** One card: what it sums up, what it says, and whether that needs a look. */
export type Summary = {
  id: string;
  icon: LucideIcon;
  /** The type it sums up, such as "Contact sensors". */
  title: string;
  /** What it says now, such as "2 open" or "All closed". */
  status: string;
  /** The status as a screen reader says it, where that differs: "19.5 to 21.5°". */
  spoken?: string;
  /** What there is to say beside that, such as "1 not known". */
  note: string | null;
  /** Whether any of what it counts is open or on, which turns it White. */
  active: boolean;
};

export function SummaryCards(props: {
  /** What the cards are, for screen readers: "Security summary". */
  label: string;
  cards: readonly Summary[];
}) {
  if (props.cards.length === 0) return null;
  return (
    <ul
      // Keep list semantics in Safari when the markers are hidden.
      role="list"
      aria-label={props.label}
      className="tile-grid m-0 shrink-0 list-none p-0"
    >
      {props.cards.map((card) => (
        <SummaryCard key={card.id} card={card} />
      ))}
    </ul>
  );
}

function SummaryCard(props: { card: Summary }) {
  const { card } = props;
  return (
    <li
      data-active={card.active ? "" : undefined}
      className="col-span-3 flex min-w-0 items-center rounded-lg bg-(--tile) px-3.5 pt-3 pb-3.5 text-(--tile-ink) backdrop-blur-[24px] data-active:bg-(--tile-on) data-active:text-(--tile-on-ink)"
    >
      <span className="flex min-w-0 flex-col">
        <span className="flex items-center gap-2 text-[13px] leading-[18px] font-medium">
          <card.icon aria-hidden="true" className="size-[18px] shrink-0" />
          {card.title}
        </span>
        {/* A pause between its lines, which a screen reader runs together. */}
        <span className="sr-only">, {card.spoken}</span>
        <span
          aria-hidden={card.spoken ? true : undefined}
          className="mt-1 text-2xl leading-8 font-light tabular-nums"
        >
          {card.status}
        </span>
        {card.note && (
          <>
            <span className="sr-only">, </span>
            <span className="mt-0.5 text-[13px] leading-[18px] font-medium">
              {card.note}
            </span>
          </>
        )}
      </span>
    </li>
  );
}

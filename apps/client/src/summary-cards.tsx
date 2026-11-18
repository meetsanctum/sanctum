import { Button, type LucideIcon } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

// What a category's page opens with: a card for each type of thing the
// category sums up, with the type's icon and name above what it says now,
// large, and a line under it where there is more to say. A card is White
// while what it counts is open or on, as its tiles are, and frosted glass
// otherwise, so what needs a look stands out before the words are read. It
// is as wide as a tile and as tall as its words, and only tells: the tiles
// below open each device. A card may hold the one action that goes with
// what it says, as a button of its own beside it, which goes under it where
// the two no longer fit side by side. The button goes once there is nothing
// left for it to do, so what it did is said to a screen reader as it
// happens, which would otherwise have to find the card's new words.

/**
 * A card's one action, such as turning off what it counts. It answers with
 * what it did, in words for a screen reader, such as "Lights turned off".
 */
export type SummaryAction = {
  label: string;
  onPress: () => Promise<string>;
};

// How long a card keeps what its action did where a screen reader finds
// it: long enough to be read out, short enough not to be met as news later.
const saidForMs = 10_000;

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
  /** Its action, only while the card is White: the button is in its ink. */
  action?: SummaryAction;
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
  // What its action last did, for a screen reader: said once it answers,
  // and gone a little later or when the action runs again, so it is never
  // read as how things are now. It goes by the clock and not by what the
  // card counts: while a press waits for its answer the lights already show
  // as asked, and come back on if it fails, so a light coming on cannot
  // tell a failed press from a later change.
  const [did, setDid] = useState<string>();
  useEffect(() => {
    if (did === undefined) return;
    const timer = window.setTimeout(() => setDid(undefined), saidForMs);
    return () => window.clearTimeout(timer);
  }, [did]);
  const action = card.action;
  return (
    <li
      data-active={card.active ? "" : undefined}
      className="col-span-3 flex min-w-0 flex-wrap items-center justify-between gap-2 rounded-lg bg-(--tile) px-3.5 pt-3 pb-3.5 text-(--tile-ink) backdrop-blur-[24px] data-active:bg-(--tile-on) data-active:text-(--tile-on-ink)"
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
      {card.active && action && (
        <Button
          variant="on-tile"
          size="chip"
          onClick={() => {
            setDid(undefined);
            void action.onPress().then(setDid);
          }}
        >
          {action.label}
        </Button>
      )}
      {/* Always there for a card with an action, so the answer is heard. */}
      {action && (
        <span role="status" className="sr-only">
          {did}
        </span>
      )}
    </li>
  );
}

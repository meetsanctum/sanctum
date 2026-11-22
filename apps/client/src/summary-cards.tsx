import type { LucideIcon } from "@meetsanctum/ui-sdk";
import { useRef } from "react";

import { useEdgeFade } from "./edge-fade";
import { statusRow, statusTile, StatusTileWords } from "./status-tile";

// What a category's page opens with: a status tile (status-tile.tsx) for
// each type of thing the category sums up, as Home's status tiles are, in
// one line that scrolls sideways. Each has the type's icon in the
// category's colour and its name over what it says now, with anything more
// beside that. It stays frosted while what it counts is open: its words
// say so, and on these rows White is a switch that is on. It only tells:
// the tiles below open each device.

/** One card: what it sums up and what it says. */
export type Summary = {
  id: string;
  icon: LucideIcon;
  /** The type it sums up, such as "Contact Sensors". */
  title: string;
  /** What it says now, such as "2 open" or "All closed". */
  status: string;
  /** The status as a screen reader says it, where that differs: "19.5 to 21.5°". */
  spoken?: string;
  /** What there is to say beside that, such as "1 not known". */
  note: string | null;
};

export function SummaryCards(props: {
  /** What the cards are, for screen readers: "Security summary". */
  label: string;
  /** The category's colour, its icons'. */
  colour: string;
  cards: readonly Summary[];
}) {
  const row = useRef<HTMLUListElement>(null);
  useEdgeFade(row, { focusWhenScrollable: true });
  if (props.cards.length === 0) return null;
  return (
    <ul
      ref={row}
      // Keep list semantics in Safari when the markers are hidden.
      role="list"
      aria-label={props.label}
      // A tab stop while it scrolls (edge-fade.ts), with the ring a tile's
      // focus has.
      className={`${statusRow} list-none rounded-lg outline-none focus-visible:ring-3 focus-visible:ring-ring/50`}
    >
      {props.cards.map((card) => (
        <li key={card.id} className={statusTile}>
          <StatusTileWords
            icon={card.icon}
            colour={props.colour}
            title={card.title}
            value={card.status}
            spoken={card.spoken}
            note={card.note}
          />
        </li>
      ))}
    </ul>
  );
}

import type { ReactNode } from "react";

import { Button } from "./components/ui/button";
import { DeviceTile } from "./device-tile";
import type { Tile, TileSection } from "./tiles";

// Every section's heading looks the same, whoever adds the section: neutral,
// in the page's own style, with no app colour and no app icon. Its level is
// 2, or 3 under a heading of its own, such as a floor's over its rooms. Given
// `onOpen`, it opens a page of its own, such as Moods' page for the room,
// with a chevron after its words. The chevron's shape says it opens a page,
// so it stays as quiet as the heading, in the secondary ink rather than
// the action colour, which a page keeps for its few actions.
export function SectionHeading(props: {
  id: string;
  level?: 2 | 3;
  children: string;
  onOpen?: () => void;
}) {
  const Heading = props.level === 3 ? "h3" : "h2";
  return (
    <Heading
      id={props.id}
      className="m-0 flex text-[15px] leading-5 font-medium"
    >
      {props.onOpen ? (
        <Button variant="ghost" size="heading" onClick={props.onOpen}>
          {props.children}
          <Chevron />
        </Button>
      ) : (
        props.children
      )}
    </Heading>
  );
}

// As tall as the words' capitals and resting on their baseline, so it sits
// with them at any text size: centred on the line instead, it rides high
// beside lower-case letters.
function Chevron() {
  return (
    <svg
      viewBox="0 0 13 13"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="size-[0.73em] text-muted-foreground"
    >
      <path d="M1.5 2 6.5 7 1.5 12" />
    </svg>
  );
}

// Tiles on the grid, in their sections, each tile a row three cells wide.
// Given `onOpen`, each tile opens its device's detail and its icon switches
// it. Given `lead`, a section has what it returns between its heading and
// its tiles, such as a button for the whole section. Given `level`, their
// headings are at that level.
export function DeviceSections(props: {
  sections: TileSection[];
  level?: 2 | 3;
  onToggle: (tile: Tile) => void;
  onDim: (tile: Tile, brightness: number) => void;
  onOpen?: (tile: Tile) => void;
  lead?: (section: TileSection) => ReactNode;
}) {
  return props.sections.map((section) => (
    <section
      key={section.id}
      aria-labelledby={`room-${section.id}`}
      className="flex flex-col gap-3"
    >
      <SectionHeading id={`room-${section.id}`} level={props.level}>
        {section.title}
      </SectionHeading>
      {props.lead?.(section)}
      <div className="grid auto-rows-(--cell) grid-cols-[repeat(auto-fill,var(--cell))] gap-(--cell-gap)">
        {section.tiles.map((tile) => (
          <DeviceTile
            key={tile.key}
            tile={tile}
            onToggle={props.onToggle}
            onDim={props.onDim}
            onOpen={props.onOpen}
          />
        ))}
      </div>
    </section>
  ));
}

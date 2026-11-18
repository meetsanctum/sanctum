import type { ReactNode } from "react";

import { DeviceTile } from "./device-tile";
import type { Tile, TileSection } from "./tiles";

// Every section's heading looks the same, whoever adds the section: neutral,
// in the page's own style, with no app colour and no app icon. Its level is
// 2, or 3 under a heading of its own, such as a floor's over its rooms.
export function SectionHeading(props: {
  id: string;
  level?: 2 | 3;
  children: string;
}) {
  const Heading = props.level === 3 ? "h3" : "h2";
  return (
    <Heading id={props.id} className="m-0 text-[15px] leading-5 font-medium">
      {props.children}
    </Heading>
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
      <div className="tile-grid auto-rows-(--cell)">
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

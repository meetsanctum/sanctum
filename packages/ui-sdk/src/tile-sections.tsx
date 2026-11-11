import { DeviceTile } from "./device-tile";
import type { Tile, TileSection } from "./tiles";

// Every section's heading looks the same, whoever adds the section: neutral,
// in the page's own style, with no app colour and no app icon.
export function SectionHeading(props: { id: string; children: string }) {
  return (
    <h2 id={props.id} className="m-0 text-[15px] leading-5 font-medium">
      {props.children}
    </h2>
  );
}

// Tiles on the grid, in their sections, each tile a row three cells wide.
// Given `onOpen`, each tile opens its device's detail and its icon switches
// it.
export function DeviceSections(props: {
  sections: TileSection[];
  onToggle: (tile: Tile) => void;
  onDim: (tile: Tile, brightness: number) => void;
  onOpen?: (tile: Tile) => void;
}) {
  return props.sections.map((section) => (
    <section
      key={section.id}
      aria-labelledby={`room-${section.id}`}
      className="flex flex-col gap-3"
    >
      <SectionHeading id={`room-${section.id}`}>{section.title}</SectionHeading>
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

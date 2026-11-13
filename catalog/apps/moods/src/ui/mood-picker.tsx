import {
  icons,
  SectionHeading,
  SectionTile,
  tileIconOf,
} from "@meetsanctum/ui-sdk";
import type { ReactNode } from "react";

import { smartCatalog, type SmartColour } from "../moods/smart.js";
import { EditorHeader } from "./mood-editing";
import { useMoodsApp } from "./state";

// A new mood's first step: a mood from the room's lights as they are, or a
// smart mood from Moods' catalog, each group in a section. A smart mood
// the room has already is there, but cannot be added again. Cancel, at its
// end, leaves without a new mood.

// A definition's colours, in the order the lights take them.
function Swatches(props: { colours: readonly SmartColour[] }) {
  return (
    <span aria-hidden="true" className="flex gap-1 py-0.5">
      {props.colours.map((colour, index) => (
        <span
          key={index}
          className="size-2.5 rounded-full"
          style={{
            background: `hsl(${colour.hue} ${colour.saturation}% 60%)`,
          }}
        />
      ))}
    </span>
  );
}

function Section(props: { id: string; title: string; children: ReactNode }) {
  return (
    <section
      aria-labelledby={`moods-${props.id}`}
      className="flex flex-col gap-3"
    >
      <SectionHeading id={`moods-${props.id}`}>{props.title}</SectionHeading>
      <div className="grid auto-rows-(--cell) grid-cols-[repeat(auto-fill,var(--cell))] gap-(--cell-gap)">
        {props.children}
      </div>
    </section>
  );
}

export function MoodPicker(props: {
  room: { id: string; name: string };
  /** "custom", or the smart mood's definition. */
  onChoose: (kind: string) => void;
  onCancel: () => void;
}) {
  const { moods } = useMoodsApp();
  const { room, onChoose } = props;
  const added = new Set(
    (moods.moods ?? [])
      .filter((mood) => mood.roomId === room.id && mood.smart)
      .map((mood) => mood.smart!.definition),
  );
  return (
    <>
      <EditorHeader
        title="New mood"
        room={room.name}
        onCancel={props.onCancel}
      />
      <Section id="own" title="Your own">
        <SectionTile
          icon={icons.Lightbulb}
          name="From the lights"
          status="As they are now"
          onClick={() => onChoose("custom")}
        />
      </Section>
      {smartCatalog.map((group) => (
        <Section key={group.id} id={group.id} title={group.name}>
          {group.moods.map((definition) => (
            <SectionTile
              key={definition.id}
              icon={tileIconOf[definition.icon]}
              name={definition.name}
              status={
                added.has(definition.id) ? (
                  "Added"
                ) : (
                  <Swatches colours={definition.colours} />
                )
              }
              disabled={added.has(definition.id)}
              onClick={() => onChoose(definition.id)}
            />
          ))}
        </Section>
      ))}
    </>
  );
}

import { useId, type CSSProperties } from "react";

import { RadioGroup, RadioGroupItem } from "./components/ui/radio-group";

// A person's identity colour, from the avatar set: a radio group of
// swatches, each 44 px to press, the chosen one rung in electric blue. The
// ring stands off the swatch by the surface it sits on, which the caller
// names: the sheet's Carbon, a card's or a dialog's fill.

export const identityColours = [
  { name: "Sage", value: "#c5cdac" },
  { name: "Blue", value: "#b9defc" },
  { name: "Peach", value: "#fcd2b3" },
  { name: "Lavender", value: "#dbcaf5" },
] as const;

/** The colour fewest of these people have, the first such one of the set. */
export function leastUsedColour(taken: readonly string[]): string {
  const uses = (value: string) =>
    taken.filter((colour) => colour.toLowerCase() === value).length;
  return identityColours.reduce((least, option) =>
    uses(option.value) < uses(least.value) ? option : least,
  ).value;
}

export function ColourPicker(props: {
  legend: string;
  // The radio group's name, unique on the page.
  name: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  // The colour behind the swatches, such as var(--card).
  surface: string;
}) {
  const title = useId();
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend
        id={title}
        className="mb-2 p-0 text-[13px] leading-[18px] font-medium text-muted-foreground"
      >
        {props.legend}
      </legend>
      <RadioGroup
        aria-labelledby={title}
        name={props.name}
        value={props.value.toLowerCase()}
        onValueChange={props.onChange}
        disabled={props.disabled}
        className="flex gap-3"
        style={{ "--swatch-surface": props.surface } as CSSProperties}
      >
        {identityColours.map((option) => (
          <RadioGroupItem
            key={option.value}
            value={option.value}
            aria-label={option.name}
            variant="swatch"
          >
            <span
              aria-hidden="true"
              className="size-8 rounded-full group-data-[state=checked]/swatch:ring-2 group-data-[state=checked]/swatch:ring-(--action) group-data-[state=checked]/swatch:ring-offset-2 group-data-[state=checked]/swatch:ring-offset-(--swatch-surface) group-focus-visible/swatch:outline-2 group-focus-visible/swatch:outline-offset-4 group-focus-visible/swatch:outline-(--action)"
              style={{ background: option.value }}
            />
          </RadioGroupItem>
        ))}
      </RadioGroup>
    </fieldset>
  );
}

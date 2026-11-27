import type { CSSProperties } from "react";

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
  // The colour behind the swatches, such as var(--card).
  surface: string;
}) {
  return (
    <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
      <legend className="mb-2 p-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
        {props.legend}
      </legend>
      <div
        className="flex gap-3"
        style={{ "--swatch-surface": props.surface } as CSSProperties}
      >
        {identityColours.map((option) => (
          <label
            key={option.value}
            className="relative flex size-11 cursor-pointer items-center justify-center"
          >
            <input
              type="radio"
              name={props.name}
              value={option.value}
              checked={props.value.toLowerCase() === option.value}
              onChange={() => props.onChange(option.value)}
              aria-label={option.name}
              className="peer absolute inset-0 m-0 cursor-pointer opacity-0"
            />
            <span
              aria-hidden="true"
              className="size-8 rounded-full peer-checked:ring-2 peer-checked:ring-(--action) peer-checked:ring-offset-2 peer-checked:ring-offset-(--swatch-surface) peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4 peer-focus-visible:outline-(--action)"
              style={{ background: option.value }}
            />
          </label>
        ))}
      </div>
    </fieldset>
  );
}

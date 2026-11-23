import { cn } from "cn";

import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";

/** One of a segmented control's choices. */
export type SegmentedOption<T extends string> = { value: T; label: string };

// A few choices side by side, one chosen at a time, like tabs: a track of
// the ink at 8%, with the chosen segment raised in the page's own colour,
// White by day and a lighter grey in the evening. For two to five short
// choices; more, or long ones, take a NativeSelect. Pressing the chosen one
// keeps it, so something is always chosen. Built on shadcn's toggle group,
// so arrow keys move between the segments and a screen reader hears radio
// buttons.

const sizes = {
  default: "h-8.5 px-3 text-sm",
  sm: "h-7.5 px-3 text-[13px]",
} as const;

/** Two to five short choices side by side, one chosen at a time. */
export function SegmentedControl<T extends string>(props: {
  options: readonly SegmentedOption<T>[];
  /** The chosen one; none while it isn't known yet. */
  value: T | undefined;
  onValueChange(value: T): void;
  /** Its accessible name, where no visible label names it. */
  label?: string;
  /** The id of the visible label that names it. */
  labelledBy?: string;
  /** The id of what explains it. */
  describedBy?: string;
  size?: keyof typeof sizes;
  /** Stretches to its container; segments are of equal width either way. */
  fill?: boolean;
  /** Long labels wrap onto a second line rather than run out of it. */
  wraps?: boolean;
  disabled?: boolean;
  /** Places it; its look comes from its size alone. */
  className?: string;
}) {
  return (
    <ToggleGroup
      type="single"
      aria-label={props.label}
      aria-labelledby={props.labelledBy}
      aria-describedby={props.describedBy}
      value={props.value ?? ""}
      onValueChange={(value: string) => {
        if (value && value !== props.value) props.onValueChange(value as T);
      }}
      disabled={props.disabled}
      spacing={1}
      // Every segment as wide as the widest, or a share of the whole width.
      className={cn(
        "inline-grid max-w-full auto-cols-fr grid-flow-col rounded-md bg-foreground/8 p-0.75",
        props.fill && "grid w-full",
        props.className,
      )}
    >
      {props.options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className={cn(
            "min-w-0 rounded-sm font-medium text-foreground hover:bg-foreground/5 hover:text-foreground pointer-coarse:h-10",
            "data-[state=on]:bg-background data-[state=on]:shadow-[0_1px_3px_rgb(0_0_0/12%)] data-[state=on]:hover:bg-background",
            "dark:data-[state=on]:bg-foreground/16 dark:data-[state=on]:hover:bg-foreground/16",
            sizes[props.size ?? "default"],
            props.wraps &&
              "h-auto min-h-7.5 px-1.5 py-1 leading-tight whitespace-normal pointer-coarse:h-auto pointer-coarse:min-h-10",
          )}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

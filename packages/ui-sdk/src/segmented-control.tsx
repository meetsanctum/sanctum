import { cn } from "cn";
import type { KeyboardEvent } from "react";

import {
  NativeSelect,
  NativeSelectOption,
} from "./components/ui/native-select";
import { ToggleGroup, ToggleGroupItem } from "./components/ui/toggle-group";

/** One of a segmented control's choices. */
export type SegmentedOption<T extends string> = { value: T; label: string };

// A few choices side by side, one chosen at a time, like tabs: a track of
// the ink at 8%, with the chosen segment raised in the page's own colour,
// White by day and a lighter grey in the evening. For two to five short
// choices; more, or long ones, take a NativeSelect, and with phoneMenu it
// becomes one on a phone where it would not fit. Arrow keys move and
// choose together, and pressing the chosen segment keeps it selected.

const sizes = {
  default: "h-8.5 px-3 text-sm",
  sm: "h-7.5 px-3 text-[13px]",
} as const;

// Toggle groups move focus with the arrows. Radio groups select as well.
function selectWithArrowKey(event: KeyboardEvent<HTMLDivElement>) {
  if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  const { currentTarget, key } = event;
  const isRtl = currentTarget.dir === "rtl";
  const isForward =
    key === "ArrowDown" || key === (isRtl ? "ArrowLeft" : "ArrowRight");
  const isBackward =
    key === "ArrowUp" || key === (isRtl ? "ArrowRight" : "ArrowLeft");
  if (!isForward && !isBackward) return;

  const segments = [
    ...currentTarget.querySelectorAll<HTMLButtonElement>(
      'button[role="radio"]:enabled',
    ),
  ];
  const currentIndex = segments.findIndex(
    (segment) => segment === event.target,
  );
  if (currentIndex === -1) return;

  event.preventDefault();
  const nextIndex =
    (currentIndex + (isForward ? 1 : -1) + segments.length) % segments.length;
  const next = segments[nextIndex]!;
  next.focus();
  next.click();
}

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
  /** On a phone, the same choices as a menu, where they wouldn't fit. */
  phoneMenu?: boolean;
  /** Places it; its look comes from its size alone. */
  className?: string;
}) {
  const segments = (
    <ToggleGroup
      type="single"
      aria-label={props.label}
      aria-labelledby={props.labelledBy}
      aria-describedby={props.describedBy}
      // Radix reserves the empty string for clearing the selected item.
      value={props.value === undefined ? "" : `:${props.value}`}
      onValueChange={(value: string) => {
        if (value) props.onValueChange(value.slice(1) as T);
      }}
      onKeyDownCapture={selectWithArrowKey}
      disabled={props.disabled}
      spacing={1}
      // Every segment as wide as the widest, or a share of the whole width,
      // but never narrower than its own label, which would run into the next.
      className={cn(
        "inline-grid max-w-full auto-cols-[minmax(min-content,1fr)] grid-flow-col rounded-md bg-foreground/8 p-0.75",
        props.fill && "grid w-full",
        props.phoneMenu && "max-sm:hidden",
        props.className,
      )}
    >
      {props.options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={`:${option.value}`}
          className={cn(
            "rounded-sm font-medium text-foreground hover:bg-foreground/5 hover:text-foreground pointer-coarse:h-10",
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
  if (!props.phoneMenu) return segments;
  return (
    <>
      {segments}
      <NativeSelect
        aria-label={props.label}
        aria-labelledby={props.labelledBy}
        aria-describedby={props.describedBy}
        // Values carry the same prefix, so no choice is mistaken for none.
        value={props.value === undefined ? "" : `:${props.value}`}
        onChange={(event) => {
          if (event.target.value) {
            props.onValueChange(event.target.value.slice(1) as T);
          }
        }}
        disabled={props.disabled}
        size={props.size === "sm" ? "sm" : "default"}
        className={cn("sm:hidden", props.fill && "w-full", props.className)}
      >
        {props.value === undefined && <NativeSelectOption value="" hidden />}
        {props.options.map((option) => (
          <NativeSelectOption key={option.value} value={`:${option.value}`}>
            {option.label}
          </NativeSelectOption>
        ))}
      </NativeSelect>
    </>
  );
}

import type { LucideIcon } from "lucide-react";
import { useEffect, useRef, type MouseEvent } from "react";

import { Button } from "./components/ui/button";
import { showFailed } from "./show-failed";

/**
 * A small button of a room section that shows buttons, beside the room's
 * button for all its lights: frosted glass, White and pressed while
 * active, with its icon and its name. A failed tap shows on it as on a
 * tile.
 */
export function SectionButton(props: {
  icon: LucideIcon;
  name: string;
  /** What it is called where several rooms' buttons are in reach. */
  label?: string;
  active: boolean;
  disabled?: boolean;
  /** How many taps on it have failed here, so it shows each. */
  failures?: number;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  const Icon = props.icon;
  const surface = useRef<HTMLButtonElement>(null);
  const wash = useRef<HTMLSpanElement>(null);
  // Only failures from while the button is shown show.
  const failures = useRef(props.failures ?? 0);
  useEffect(() => {
    if ((props.failures ?? 0) <= failures.current) return;
    failures.current = props.failures ?? 0;
    showFailed(surface.current, wash.current);
  }, [props.failures]);
  return (
    <Button
      ref={surface}
      variant="glass"
      size="chip"
      aria-label={props.label}
      aria-pressed={props.active}
      disabled={props.disabled}
      onClick={props.onClick}
      className="relative"
    >
      <span
        ref={wash}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-[inherit] bg-(--danger) opacity-0"
      />
      <Icon aria-hidden="true" data-icon="inline-start" className="relative" />
      <span className="relative">{props.name}</span>
    </Button>
  );
}

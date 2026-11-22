import { Switch } from "@meetsanctum/ui-sdk";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

// A line of what AI agents can use: what it is, a line under it, and its
// switch, or the words that say it has none. The line under it wraps rather
// than cut short, since it says what the switch covers.

export function CanUseRow(props: {
  icon?: LucideIcon;
  title: string;
  detail?: ReactNode;
  // On with no switch, as seeing the rooms is.
  always?: boolean;
  on: boolean;
  disabled?: boolean;
  onSwitch: (on: boolean) => void;
}) {
  const Icon = props.icon;
  return (
    <li className="flex min-w-0 items-center gap-3">
      {Icon && (
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/8"
        >
          <Icon className="size-4" />
        </span>
      )}
      <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
        <span className="text-sm font-medium">{props.title}</span>
        {props.detail && (
          <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
            {props.detail}
          </span>
        )}
      </span>
      {props.always ? (
        <span className="shrink-0 text-[13px] font-medium text-muted-foreground">
          Always on
        </span>
      ) : (
        <Switch
          aria-label={props.title}
          checked={props.on}
          disabled={props.disabled}
          onCheckedChange={props.onSwitch}
        />
      )}
    </li>
  );
}

export function CanUseRows(props: { children: ReactNode }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">{props.children}</ul>
  );
}

/** The words under a list, or what went wrong with the last change. */
export function CanUseNote(props: { problem?: string; children: ReactNode }) {
  return (
    <>
      {props.problem && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {props.problem}
        </p>
      )}
      <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
        {props.children}
      </p>
    </>
  );
}

export const switchProblem = "That did not work. Try again.";

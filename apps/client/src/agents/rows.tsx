import { Problem, Switch } from "@meetsanctum/ui-sdk";
import type { LucideIcon } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";

import { CoreError } from "../core-fetch";
import { problemReason } from "../device-parts";

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
  onSwitch: (on: boolean, trigger: HTMLButtonElement | null) => void;
}) {
  const Icon = props.icon;
  const detailId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
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
          <span
            id={detailId}
            className="text-[13px] leading-[18px] font-medium text-muted-foreground"
          >
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
          ref={trigger}
          aria-label={props.title}
          aria-describedby={props.detail ? detailId : undefined}
          checked={props.on}
          disabled={props.disabled}
          onCheckedChange={(on) => props.onSwitch(on, trigger.current)}
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

/** The words under a list, after what went wrong with its last change. */
export function CanUseNote(props: {
  problem?: SwitchProblem;
  children: ReactNode;
}) {
  return (
    <>
      {props.problem && (
        <Problem title={props.problem.title}>{props.problem.reason}</Problem>
      )}
      <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
        {props.children}
      </p>
    </>
  );
}

type SwitchProblem = { id: string; on: boolean; title: string; reason: string };

/** Keep the alert until the saved value confirms the requested setting. */
export function useSwitchProblem(
  items: readonly { id: string; on: boolean }[],
) {
  const [problem, setProblem] = useState<SwitchProblem>();
  const confirmed =
    problem && items.find((item) => item.id === problem.id)?.on === problem.on;
  useEffect(() => {
    if (confirmed) setProblem(undefined);
  }, [confirmed]);
  return [confirmed ? undefined : problem, setProblem] as const;
}

export function switchProblem(
  id: string,
  title: string,
  on: boolean,
  error: unknown,
): SwitchProblem {
  const setting = on ? "on" : "off";
  const refused =
    error instanceof CoreError && error.status < 500 && error.status !== 408;
  return {
    id,
    on,
    title: refused
      ? `“${title}” wasn't turned ${setting}`
      : `Couldn't confirm that “${title}” was turned ${setting}`,
    reason: problemReason(error),
  };
}

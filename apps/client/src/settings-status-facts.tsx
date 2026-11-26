import { cn } from "cn";
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

// System's label and value rows, as in iOS's About: a fact's name, and what
// it is at the end of its line, wrapping rather than cut off; a problem in
// red after a sign.

export function Fact(props: {
  label: string;
  children: ReactNode;
  problem?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
      <dt className="text-sm font-medium">{props.label}</dt>
      <dd
        className={cn(
          "m-0 flex min-w-0 items-center gap-1 text-end text-sm text-muted-foreground tabular-nums",
          props.problem && "text-destructive",
        )}
      >
        {props.problem && (
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        )}
        {props.children}
      </dd>
    </div>
  );
}

export const Facts = (props: { children: ReactNode }) => (
  <dl className="m-0 flex flex-col gap-3">{props.children}</dl>
);

import { cn } from "cn";
import type { ReactNode } from "react";

// A section of an app's page: a neutral heading, with a hint or a button
// beside it when it needs one, over a card that holds the section. A card is
// a fill, the ink at 5% over the page, with no hairline; cards never nest,
// so what sits in one is set apart by space.

export function PageSection(props: {
  id: string;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={props.id}
      className={cn("flex min-w-0 shrink-0 flex-col gap-2", props.className)}
    >
      <div className="flex min-h-7 flex-wrap items-baseline justify-between gap-x-2">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h2
            id={props.id}
            className="m-0 text-[15px] leading-[22px] font-medium"
          >
            {props.title}
          </h2>
          {props.hint && (
            <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
              {props.hint}
            </span>
          )}
        </div>
        {props.action}
      </div>
      <Card>{props.children}</Card>
    </section>
  );
}

/** A card on an app's page: the ink at 5%, 15 px corners and 6 px in. */
export function Card(props: { className?: string; children: ReactNode }) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-0.5 rounded-lg bg-card p-1.5 text-card-foreground",
        props.className,
      )}
    >
      {props.children}
    </div>
  );
}

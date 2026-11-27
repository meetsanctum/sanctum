import { cn } from "cn";
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

/**
 * What went wrong, said in what failed: a red sign, then what happened in
 * the ink and what to do in the quieter grey. It sits on the card's fill, so
 * its words read the same on a page, in a dialog or over frosted glass, and
 * they can be selected. Trying again is the button that failed, never words
 * in here. A problem with a field is a line under the field instead.
 */
export function Problem(props: {
  /** What happened to what: "Light 25 didn't blink". */
  title: ReactNode;
  /** Why, where it is known, and what to do. */
  children?: ReactNode;
  id?: string;
  /** Places it, such as across a row of buttons; never restyles it. */
  className?: string;
}) {
  return (
    <div
      id={props.id}
      role="alert"
      className={cn(
        "flex items-start gap-2.5 rounded-md bg-card px-3.5 py-3 text-start text-card-foreground select-text",
        props.className,
      )}
    >
      <CircleAlert
        aria-hidden="true"
        className="mt-px size-4.5 shrink-0 text-destructive"
      />
      <div className="min-w-0">
        <p className="m-0 text-sm leading-5 font-semibold">{props.title}</p>
        {props.children && (
          <p className="m-0 mt-0.5 text-[13px] leading-[18px] text-muted-foreground">
            {props.children}
          </p>
        )}
      </div>
    </div>
  );
}

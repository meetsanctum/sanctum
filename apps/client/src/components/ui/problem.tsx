import { CircleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "./alert";

/**
 * What went wrong, said in what failed: a red sign, then what happened in
 * the ink and what to do in the quieter grey. It sits on the card's fill, so
 * its words read the same on a page, in a dialog or over frosted glass, and
 * they can be selected. Trying again is the button that failed, never words
 * in here. A problem with a field is a line under the field instead.
 */
export function Problem(props: {
  /** What happened to what: "Light 25 didn't blink". */
  title: string;
  /** Why, where it is known, and what to do. */
  children?: string;
  /** Places it, such as across a row of buttons; never restyles it. */
  className?: string;
}) {
  return (
    <Alert className={props.className}>
      <CircleAlert
        aria-hidden="true"
        className="mt-px size-4.5 shrink-0 text-destructive"
      />
      <div className="min-w-0 wrap-anywhere">
        <AlertTitle>{props.title}</AlertTitle>
        {props.children && (
          <AlertDescription>{props.children}</AlertDescription>
        )}
      </div>
    </Alert>
  );
}

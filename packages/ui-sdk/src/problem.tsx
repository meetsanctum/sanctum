import { CircleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";

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
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{props.title}</AlertTitle>
      {props.children && <AlertDescription>{props.children}</AlertDescription>}
    </Alert>
  );
}

/**
 * What to change in a field, under it: a red sign with red words, such as
 * "Use a number from 1 to 14." It is not a notice, since the field is where
 * it's fixed. Give the field `aria-invalid` and point its `aria-describedby`
 * at this line's `id`.
 */
export function FieldProblem(props: {
  /** For the field's aria-describedby. */
  id?: string;
  /** What to change, as an instruction. */
  children: string;
}) {
  return (
    <p
      id={props.id}
      role="alert"
      className="m-0 flex items-start gap-2 text-sm leading-5 text-destructive select-text"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span className="wrap-anywhere">{props.children}</span>
    </p>
  );
}

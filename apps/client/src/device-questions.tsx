import type { DeviceQuestion } from "@meetsanctum/app-sdk";
import { Input } from "@meetsanctum/ui-sdk";
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

// A question a device's driver asks, as adding or repairing it does: its
// label, its field, and under it where to find the answer or, once the
// driver refused what was typed, why, in the words the question declares.
// A secret's field hides what's typed, and nothing in it is corrected or
// filled in for someone. A code a device shows gets a number pad, and where
// it lasts only a while, the time remaining follows its help, until the time
// is up and the field empties.

/** The words a refusal says, under the question it's about. */
export type Refused = { question: string; refusal: string };

export function refusalWords(
  asks: readonly DeviceQuestion[],
  refused: Refused,
) {
  return asks.find((question) => question.id === refused.question)?.refusals[
    refused.refusal
  ];
}

export function QuestionField(props: {
  id: string;
  question: DeviceQuestion;
  value: string;
  refused?: Refused;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  // Beside the field, such as the button that sends the answers.
  beside?: ReactNode;
  // The field shares a narrow card with what is beside it, rather than
  // taking a line of its own.
  narrow?: boolean;
  disabled?: boolean;
  // The seconds a question that lasts has left, or that its time is up.
  remaining?: number | "up";
}) {
  const { id, question, refused, remaining } = props;
  const why =
    refused?.question === question.id
      ? question.refusals[refused.refusal]
      : undefined;
  const isCode = question.kind === "code";
  const isUp = remaining === "up";
  const help = isUp
    ? "Time to enter this code is up."
    : why
      ? null
      : question.help;
  const showHelp = help || typeof remaining === "number";
  const refusalId = `${id}-refused`;
  const helpId = `${id}-help`;
  const describedBy = [why ? refusalId : null, showHelp ? helpId : null]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div
          className={
            props.narrow
              ? "flex min-w-0 flex-1 flex-col gap-2"
              : "flex min-w-0 flex-[1_1_220px] flex-col gap-2"
          }
        >
          <label htmlFor={id} className="text-sm font-medium">
            {question.label}
          </label>
          <Input
            id={id}
            type={question.kind === "secret" ? "password" : "text"}
            value={isUp ? "" : props.value}
            placeholder={question.placeholder ?? undefined}
            // Not one-time-code: a phone would offer codes from its messages.
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            inputMode={isCode ? "numeric" : undefined}
            maxLength={isCode ? (question.length ?? undefined) : undefined}
            className={isCode ? "tabular-nums" : undefined}
            disabled={props.disabled || isUp}
            autoFocus={props.autoFocus}
            aria-invalid={why ? true : undefined}
            aria-describedby={describedBy || undefined}
            onChange={(event) => props.onChange(event.target.value)}
          />
        </div>
        {props.beside}
      </div>
      {why && (
        <p
          id={refusalId}
          role="alert"
          className="m-0 flex items-start gap-1.5 text-sm text-destructive"
        >
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span>{why}</span>
        </p>
      )}
      {showHelp && (
        <p id={helpId} className="m-0 text-sm text-muted-foreground">
          {help}
          {typeof remaining === "number" && (
            <>
              {help && " "}
              <span
                className={
                  remaining <= 10
                    ? "whitespace-nowrap text-(--sun-text) tabular-nums"
                    : "whitespace-nowrap tabular-nums"
                }
              >
                {remaining} s remaining
              </span>
            </>
          )}
        </p>
      )}
    </div>
  );
}

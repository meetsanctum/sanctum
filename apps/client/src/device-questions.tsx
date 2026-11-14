import type { DeviceQuestion } from "@meetsanctum/app-sdk";
import { Input } from "@meetsanctum/ui-sdk";
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";

// A question a device's driver asks, as adding or repairing it does: its
// label, its field, and under it where to find the answer or, once the
// driver refused what was typed, why, in the words the question declares.
// A secret's field hides what's typed, and nothing in it is corrected or
// filled in for someone.

/** The words a refusal says, under the question it's about. */
export type Refused = { question: string; refusal: string };

export function QuestionField(props: {
  id: string;
  question: DeviceQuestion;
  value: string;
  refused?: Refused;
  autoFocus?: boolean;
  onChange: (value: string) => void;
  // Beside the field, such as the button that sends the answers.
  beside?: ReactNode;
}) {
  const { id, question, refused } = props;
  const why =
    refused?.question === question.id
      ? question.refusals[refused.refusal]
      : undefined;
  const said = why ? `${id}-refused` : `${id}-help`;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex min-w-0 flex-[1_1_220px] flex-col gap-2">
          <label htmlFor={id} className="text-sm font-medium">
            {question.label}
          </label>
          <Input
            id={id}
            type={question.kind === "secret" ? "password" : "text"}
            value={props.value}
            placeholder={question.placeholder ?? undefined}
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            autoFocus={props.autoFocus}
            aria-invalid={why ? true : undefined}
            aria-describedby={why || question.help ? said : undefined}
            onChange={(event) => props.onChange(event.target.value)}
          />
        </div>
        {props.beside}
      </div>
      {why ? (
        <p
          id={said}
          role="alert"
          className="m-0 flex items-start gap-1.5 text-sm text-destructive"
        >
          <CircleAlert
            aria-hidden="true"
            className="mt-0.5 size-3.5 shrink-0"
          />
          <span>{why}</span>
        </p>
      ) : (
        question.help && (
          <p id={said} className="m-0 text-sm text-muted-foreground">
            {question.help}
          </p>
        )
      )}
    </div>
  );
}

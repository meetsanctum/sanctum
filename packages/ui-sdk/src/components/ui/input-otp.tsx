import * as React from "react";
import { cn } from "cn";

// A short code typed into boxes, one character each: a pairing code, a
// one-time code. Under the boxes lies one real input, so typing, pasting,
// deleting and screen readers work as in any field; the boxes only draw
// what it holds. The caret stays at the end and stays still while the
// screen waits for a code. Select All can still replace the whole code.

type InputOTPContext = { value: string; maxLength: number; focused: boolean };

const InputOTPContext = React.createContext<InputOTPContext>({
  value: "",
  maxLength: 0,
  focused: false,
});

function InputOTP({
  value,
  maxLength,
  onChange,
  onComplete,
  filter,
  containerClassName,
  className,
  children,
  onFocus,
  onBlur,
  ...props
}: Omit<
  React.ComponentProps<"input">,
  "value" | "onChange" | "maxLength" | "type" | "onSelect"
> & {
  value: string;
  maxLength: number;
  onChange: (value: string) => void;
  // Once every box is filled by typing or pasting.
  onComplete?: (value: string) => void;
  // What of the typed or pasted text the boxes keep, such as capitals
  // without dashes; the rest is dropped before it is counted.
  filter?: (typed: string) => string;
  containerClassName?: string;
}) {
  const [focused, setFocused] = React.useState(false);

  // The caret stays at the end, where the next character goes.
  const toEnd = (input: HTMLInputElement) => {
    const end = input.value.length;
    if (input.selectionStart === 0 && input.selectionEnd === end) return;
    if (input.selectionStart !== end || input.selectionEnd !== end) {
      input.setSelectionRange(end, end);
    }
  };

  return (
    <InputOTPContext.Provider value={{ value, maxLength, focused }}>
      <div
        data-slot="input-otp"
        aria-invalid={props["aria-invalid"]}
        className={cn(
          "group/input-otp relative flex w-full items-center justify-center gap-2 has-disabled:opacity-50 max-sm:gap-1",
          containerClassName,
        )}
      >
        {children}
        <input
          autoComplete="off"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          {...props}
          type="text"
          value={value}
          onChange={(event) => {
            const typed = event.target.value;
            const next = (filter ? filter(typed) : typed).slice(0, maxLength);
            if (next === value) return;
            onChange(next);
            if (next.length === maxLength) {
              onComplete?.(next);
            }
          }}
          onSelect={(event) => toEnd(event.currentTarget)}
          onFocus={(event) => {
            setFocused(true);
            toEnd(event.currentTarget);
            onFocus?.(event);
          }}
          onBlur={(event) => {
            setFocused(false);
            onBlur?.(event);
          }}
          // Over the boxes, so a click or tap anywhere on them focuses it;
          // 16 px text keeps phones from zooming in on focus.
          className={cn(
            "absolute inset-0 size-full cursor-text border-0 bg-transparent p-0 text-base text-transparent caret-transparent opacity-0 outline-none disabled:cursor-not-allowed",
            className,
          )}
        />
      </div>
    </InputOTPContext.Provider>
  );
}

// The same boxes showing a code to copy rather than one to type, such as
// the code a shared device shows for another device to type in: no input
// lies under them, so nothing takes focus or reads as a field. The boxes are
// drawn for the eye; the page says the code in words for screen readers.
// Empty boxes stand in while there is no code yet.
function InputOTPDisplay({
  value,
  maxLength,
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & { value: string; maxLength: number }) {
  return (
    <InputOTPContext.Provider value={{ value, maxLength, focused: false }}>
      <div
        data-slot="input-otp-display"
        aria-hidden="true"
        className={cn(
          "flex w-full items-center justify-center gap-2 max-sm:gap-1",
          className,
        )}
        {...props}
      >
        {children}
      </div>
    </InputOTPContext.Provider>
  );
}

function InputOTPGroup({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-group"
      className={cn(
        "flex min-w-0 flex-1 items-center justify-center gap-2 max-sm:gap-1",
        className,
      )}
      {...props}
    />
  );
}

function InputOTPSlot({
  index,
  className,
  ...props
}: React.ComponentProps<"div"> & { index: number }) {
  const { value, maxLength, focused } = React.useContext(InputOTPContext);
  const char = value[index];
  // The box the next character goes in, or the last once all are filled.
  const active =
    focused && index === Math.min(value.length, Math.max(maxLength - 1, 0));
  return (
    <div
      data-slot="input-otp-slot"
      data-active={active || undefined}
      aria-hidden="true"
      className={cn(
        // Up to 40 px wide, narrower on a narrow screen, so the whole code
        // always fits; closer together and less rounded there, so a narrow
        // box stays a box.
        "flex h-13 max-w-10 min-w-0 flex-1 basis-10 items-center justify-center rounded-md max-sm:rounded-sm border border-input text-2xl tabular-nums shadow-xs reduce-effects:shadow-none dark:bg-input/30",
        "group-aria-invalid/input-otp:border-destructive group-aria-invalid/input-otp:ring-3 group-aria-invalid/input-otp:ring-destructive/20 dark:group-aria-invalid/input-otp:ring-destructive/40",
        "data-active:border-ring data-active:ring-3 data-active:ring-ring/50",
        className,
      )}
      {...props}
    >
      {char ?? (active ? <span className="h-6 w-px bg-foreground" /> : null)}
    </div>
  );
}

function InputOTPSeparator({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="input-otp-separator"
      aria-hidden="true"
      className={cn("flex items-center px-2 max-sm:px-1", className)}
      {...props}
    >
      <span className="h-0.5 w-4 bg-muted-foreground" />
    </div>
  );
}

export {
  InputOTP,
  InputOTPDisplay,
  InputOTPGroup,
  InputOTPSlot,
  InputOTPSeparator,
};

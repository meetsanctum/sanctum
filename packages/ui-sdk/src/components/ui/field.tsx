import type { ComponentProps } from "react";
import { cn } from "cn";

// shadcn's FieldError (radix-vega), as a line under the field.
export function FieldError({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      role="alert"
      data-slot="field-error"
      className={cn(
        "m-0 flex items-start gap-2 text-sm leading-5 text-destructive select-text",
        className,
      )}
      {...props}
    />
  );
}

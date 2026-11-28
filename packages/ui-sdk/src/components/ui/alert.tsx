import * as React from "react";
import { cn } from "cn";

// shadcn's Alert (radix-vega), as Sanctum's problem notice: on the card's
// fill with no border and corners from the radius scale, its words
// selectable, the sign in the danger colour, what happened in the ink and
// what to do in the quieter grey. Without the destructive variant, whose red
// words fall below 4.5 : 1 over frosted glass, and without an action, since
// trying again is the button that failed.
function Alert({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(
        "group/alert relative grid w-full gap-0.5 rounded-md bg-card px-3.5 py-3 text-start text-card-foreground select-text has-[>svg]:grid-cols-[auto_1fr] has-[>svg]:gap-x-2.5 *:[svg]:row-span-2 *:[svg]:mt-px *:[svg]:text-destructive *:[svg:not([class*='size-'])]:size-4.5",
        className,
      )}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "text-sm leading-5 font-semibold wrap-anywhere group-has-[>svg]/alert:col-start-2",
        className,
      )}
      {...props}
    />
  );
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "text-[13px] leading-[18px] wrap-anywhere text-muted-foreground group-has-[>svg]/alert:col-start-2",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };

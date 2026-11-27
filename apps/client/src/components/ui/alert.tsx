import { cn } from "cn";
import type { ComponentProps } from "react";

// shadcn's Alert (radix-vega) uses the card fill without a border here.

function Alert({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(
        "flex items-start gap-2.5 rounded-md bg-card px-3.5 py-3 text-start text-card-foreground select-text",
        className,
      )}
      {...props}
    />
  );
}

function AlertTitle({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="alert-title"
      className={cn("m-0 text-sm leading-5 font-semibold", className)}
      {...props}
    />
  );
}

function AlertDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      data-slot="alert-description"
      className={cn(
        "m-0 mt-0.5 text-[13px] leading-[18px] text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}

export { Alert, AlertTitle, AlertDescription };

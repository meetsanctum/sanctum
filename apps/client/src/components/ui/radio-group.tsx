import * as React from "react";
import { cn } from "cn";
import { RadioGroup as RadioGroupPrimitive } from "radix-ui";

function RadioGroup({
  className,
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Root>) {
  return (
    <RadioGroupPrimitive.Root
      data-slot="radio-group"
      className={cn("grid gap-3", className)}
      {...props}
    />
  );
}

function RadioGroupItem({
  className,
  children,
  variant = "default",
  ...props
}: React.ComponentProps<typeof RadioGroupPrimitive.Item> & {
  variant?: "default" | "swatch";
}) {
  return (
    <RadioGroupPrimitive.Item
      data-slot="radio-group-item"
      className={cn(
        "relative shrink-0 outline-none disabled:cursor-not-allowed disabled:opacity-50",
        variant === "swatch"
          ? "group/swatch flex size-11 cursor-pointer items-center justify-center"
          : "peer aspect-square size-4 rounded-full border border-input focus-visible:ring-3 focus-visible:ring-ring/50",
        className,
      )}
      {...props}
    >
      {variant === "swatch" ? (
        children
      ) : (
        <RadioGroupPrimitive.Indicator
          data-slot="radio-group-indicator"
          className="grid place-content-center"
        >
          <span className="size-2 rounded-full bg-primary" />
        </RadioGroupPrimitive.Indicator>
      )}
    </RadioGroupPrimitive.Item>
  );
}

export { RadioGroup, RadioGroupItem };

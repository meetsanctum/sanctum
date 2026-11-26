import * as React from "react";
import { cn } from "cn";

// shadcn's Skeleton: the shape of what is on its way, in the ink at 8%. It
// holds still rather than pulsing, so nothing runs on a slow wall display
// while it waits. A span, so it fits inside a line as well as a list; give
// it its size and corners where it stands.

function Skeleton({ className, ...props }: React.ComponentProps<"span">) {
  return (
    <span
      data-slot="skeleton"
      aria-hidden="true"
      className={cn("block rounded-sm bg-foreground/8", className)}
      {...props}
    />
  );
}

export { Skeleton };

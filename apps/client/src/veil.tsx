import { cn } from "cn";
import type { ComponentProps, ReactNode } from "react";

import { WindowDragArea } from "./components";
import { KnotLoader } from "./knot-loader";

// A veil: frosted glass over the whole screen while it cannot be used,
// saying why calmly and keeping the page in place behind it. It covers the
// top bar too, since nothing there helps meanwhile, and on macOS its top
// strip still moves the window. It fades in after a moment
// (src/styles.css), so a blip passes unnoticed. The connection uses it
// (src/connection-veil.tsx), and so may anything else that holds the whole
// screen for a while.
//
// Its glass (VeilGlass) is the one look of whatever covers the whole
// screen: a veil, and an overlay such as a device's detail or Add devices
// (src/overlay.tsx), which renders it too. Over a White page it is deeper
// (src/shell-frame.css).
export function VeilGlass({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-mode="evening"
      {...props}
      className={cn(
        "veil-glass fixed inset-0 bg-(--carbon)/60 text-white backdrop-blur-[24px]",
        className,
      )}
    />
  );
}

export function Veil(props: {
  title: string;
  children: ReactNode;
  // Something is under way, and the screen comes back by itself.
  busy?: boolean;
  // A way out, at most one primary action.
  action?: ReactNode;
}) {
  return (
    <VeilGlass className="veil z-20 flex flex-col items-center justify-center gap-5 p-6 text-center">
      <WindowDragArea />
      <div role="status" className="flex flex-col items-center gap-2">
        {props.busy && <KnotLoader className="mb-1 size-7 text-white/65" />}
        <p className="m-0 text-[17px] leading-[27px]">{props.title}</p>
        <p className="m-0 max-w-sm text-sm text-white/65">{props.children}</p>
      </div>
      {props.action}
    </VeilGlass>
  );
}

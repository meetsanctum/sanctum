import type { ReactNode } from "react";

import { WindowDragArea } from "./components";
import { KnotLoader } from "./knot-loader";

// A veil: frosted glass over the whole screen while it cannot be used,
// saying why calmly and keeping the page in place behind it. It covers the
// top bar too, since nothing there helps meanwhile, and on macOS its top
// strip still moves the window. It fades in after a moment
// (src/styles.css), so a blip passes unnoticed. The connection uses it
// (src/connection-veil.tsx), and so may anything else that holds the whole
// screen for a while.
export function Veil(props: {
  title: string;
  children: ReactNode;
  // Something is under way, and the screen comes back by itself.
  busy?: boolean;
  // A way out, at most one primary action.
  action?: ReactNode;
}) {
  return (
    <div
      data-mode="evening"
      className="veil fixed inset-0 z-20 flex flex-col items-center justify-center gap-5 bg-(--carbon)/60 p-6 text-center text-white backdrop-blur-[24px]"
    >
      <WindowDragArea />
      <div role="status" className="flex flex-col items-center gap-2">
        {props.busy && <KnotLoader className="mb-1 size-7 text-white/65" />}
        <p className="m-0 text-[17px] leading-[27px]">{props.title}</p>
        <p className="m-0 max-w-sm text-sm text-white/65">{props.children}</p>
      </div>
      {props.action}
    </div>
  );
}

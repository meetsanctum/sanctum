import { cn } from "cn";
import {
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ReactNode,
} from "react";

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
// (src/shell-frame.css). It may take a colour (`tint`), such as what a media
// player plays, laid over its Carbon so the glass turns towards it without
// ceasing to be the veil.
export function VeilGlass({
  className,
  tint,
  children,
  ...props
}: ComponentProps<"div"> & { tint?: string | null }) {
  return (
    <div
      data-mode="evening"
      {...props}
      className={cn(
        "veil-glass fixed inset-0 bg-(--carbon)/60 text-white backdrop-blur-[24px]",
        className,
      )}
    >
      <VeilTint tint={tint ?? null} />
      {children}
    </div>
  );
}

// How long a new tint takes to come in, as the old one goes, in ms.
const tintFadeMs = 600;

// The veil's tint at 45% over its Carbon, behind what it holds. A new one
// fades in on a layer of its own as the last fades out, by opacity alone,
// as the shell animates only transform and opacity.
function VeilTint(props: { tint: string | null }) {
  const [layers, setLayers] = useState<{ id: number; colour: string }[]>([]);
  const counter = useRef(0);
  useEffect(() => {
    setLayers((current) => {
      if ((current.at(-1)?.colour ?? null) === props.tint) return current;
      const kept = current.slice(-1);
      if (props.tint === null) return kept.length > 0 ? kept : current;
      counter.current += 1;
      return [...kept, { id: counter.current, colour: props.tint }];
    });
    const timer = setTimeout(
      () =>
        setLayers((current) => (props.tint === null ? [] : current.slice(-1))),
      tintFadeMs + 100,
    );
    return () => clearTimeout(timer);
  }, [props.tint]);
  return layers.map((layer, index) => {
    const isCurrent = index === layers.length - 1 && props.tint !== null;
    return (
      <span
        key={layer.id}
        aria-hidden="true"
        data-tint={layer.colour}
        className={cn(
          "pointer-events-none absolute inset-0 -z-10 transition-opacity duration-600",
          isCurrent ? "animate-in fade-in-0 duration-600" : "opacity-0",
        )}
        style={{
          background: `color-mix(in oklab, ${layer.colour} 45%, transparent)`,
        }}
      />
    );
  });
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

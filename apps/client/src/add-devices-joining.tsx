import type { DeviceInfo, JoinedDevice } from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

import { JoinedCard, type CardWork } from "./add-devices-cards";
import { foundKey } from "./add-devices-found";
import { KnotLoader } from "./knot-loader";
import { knotPath } from "./knot";

// Add devices' page of one radio, such as Zigbee, which lets new devices
// join while it is open. Until one joins, the page is calm and centred: the
// knot at 84 px on a glow that breathes, with rings drifting out from it,
// the time left and Stop looking. When the first joins, the knot, the
// heading and Stop looking move straight up together, the knot shrinking to
// 42 px, and the devices' cards rise in under them. Once the time is up or
// someone stops, the knot holds still over Start again.

/** Minutes and seconds, as a countdown shows them: 3:52. */
export function countdown(seconds: number) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** How long a radio lets devices join, in words: "4 minutes". */
const lasting = (seconds: number) => {
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
};

export type JoiningState =
  // Asking the radio to let devices join.
  | { kind: "opening" }
  | { kind: "open"; secondsLeft: number }
  // Not letting devices join: the time ran out, someone stopped it, or the
  // radio could not start.
  | { kind: "closed"; why: "time" | "stopped" | "failed" };

export function JoiningPage(props: {
  // The radio's app, such as Zigbee, when its name is known.
  name: string | null;
  state: JoiningState;
  joined: readonly JoinedDevice[];
  devices: readonly DeviceInfo[];
  // How long it lets devices join each time.
  seconds: number;
  onStop: () => void;
  onStartAgain: () => void;
  work: CardWork;
}) {
  const { state } = props;
  // A device removed here is gone from the list it joined.
  const joined = props.joined.filter(
    (each) => !(each.stage === "ready" && each.deviceId === null),
  );
  const hasJoined = joined.length > 0;
  const isLooking = state.kind !== "closed";
  // Calm and centred until a device joins; then at the top over the cards.
  const isWaiting = isLooking && !hasJoined;
  const kind = props.name ? `${props.name} devices` : "New devices";
  // The line under the heading while it waits, and once it has stopped
  // with nothing to show.
  const line = isWaiting
    ? `${kind} can join for ${lasting(props.seconds)}. When the time is up, you can start again.`
    : !isLooking && state.why !== "failed"
      ? `${kind} can't join right now. Start again to give them another ${lasting(props.seconds)}.`
      : null;
  const gone = useGoneLine(line);
  const at = useMoveUp(isWaiting, line);
  // The first cards rise in once the move up has nearly ended, so the
  // button never passes through them; those that come later rise in at
  // once.
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!hasJoined) {
      setSettled(false);
      return;
    }
    const timer = window.setTimeout(() => setSettled(true), moving + 300);
    return () => window.clearTimeout(timer);
  }, [hasJoined]);

  const heading =
    state.kind === "opening" ? (
      "Getting ready…"
    ) : state.kind === "open" ? (
      <>
        <span className="tabular-nums">{countdown(state.secondsLeft)}</span>
        <span aria-hidden="true" className="mx-2.5 font-medium text-(--pewter)">
          •
        </span>
        <span className="sr-only"> left. </span>
        Looking for devices…
      </>
    ) : state.why === "stopped" ? (
      "Stopped looking"
    ) : state.why === "failed" ? (
      "Couldn't start looking"
    ) : (
      "Time's up"
    );

  return (
    <div
      className={cn(
        "flex flex-col items-center",
        isWaiting ? "flex-1 justify-center pb-16" : "gap-8",
      )}
    >
      <div className="relative flex flex-col items-center text-center">
        {isWaiting && <Orb />}
        <span
          ref={at.knot}
          className={cn(
            "relative flex items-center justify-center",
            isWaiting ? "size-21" : "size-10.5",
          )}
        >
          <span
            className={cn(
              "absolute top-1/2 left-1/2 flex size-21 -translate-1/2 items-center justify-center transition-transform duration-900 ease-[cubic-bezier(.2,.8,.2,1)] motion-reduce:transition-none",
              !isWaiting && "scale-50",
            )}
          >
            {isLooking ? (
              <KnotLoader className="size-21" />
            ) : (
              <svg
                viewBox="0 0 14 14"
                aria-hidden="true"
                className="size-21 fill-current"
              >
                <path d={knotPath} />
              </svg>
            )}
          </span>
        </span>
        <h3
          ref={at.heading}
          className={cn(
            "m-0 font-semibold tracking-[-0.01em]",
            isWaiting ? "mt-7 text-[22px] leading-7" : "mt-3 text-lg leading-6",
          )}
        >
          {heading}
        </h3>
        {line !== null && (
          <p
            key={line}
            ref={at.line(line)}
            className="m-0 mt-2 max-w-105 text-[14.5px] leading-[1.5] text-(--silver)"
          >
            {line}
          </p>
        )}
        {gone !== null && (
          // The line that was, out of the flow and seen only while it fades
          // on its way up, so it doesn't vanish in a frame.
          <p
            key={`gone:${gone}`}
            ref={at.gone(gone)}
            aria-hidden="true"
            className="pointer-events-none absolute m-0 mt-2 max-w-105 text-[14.5px] leading-[1.5] text-(--silver) opacity-0"
          >
            {gone}
          </p>
        )}
        <span
          ref={at.button}
          className={cn("flex", isWaiting ? "mt-5" : "mt-3.5")}
        >
          {isLooking ? (
            <Button
              variant="outline"
              disabled={state.kind === "opening"}
              onClick={props.onStop}
            >
              Stop looking
            </Button>
          ) : (
            <Button onClick={props.onStartAgain}>
              {state.why === "failed" ? "Try again" : "Start again"}
            </Button>
          )}
        </span>
      </div>
      {hasJoined && (
        <ul
          aria-label="Devices that joined"
          style={
            {
              "--cards-after": settled ? "0ms" : `${moving / 2}ms`,
            } as CSSProperties
          }
          className="m-0 grid w-full list-none grid-cols-2 gap-3 p-0 sm:grid-cols-4 sm:gap-4"
        >
          {joined.map((each, index) => (
            <JoinedCard
              key={foundKey(each)}
              joined={each}
              index={index}
              device={props.devices.find(
                (device) => device.id === each.deviceId,
              )}
              work={props.work}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

// The glow the knot waits on, and the rings that drift out from it in step
// with its turn (src/styles.css).
function Orb(): ReactNode {
  return (
    <span aria-hidden="true" className="add-devices-orb">
      <span className="add-devices-halo" />
      <span className="add-devices-ring" />
      <span className="add-devices-ring" />
      <span className="add-devices-ring" />
    </span>
  );
}

type Place = { middle: number; top: number; width: number; size: number };

/** How long the move up takes, in milliseconds. */
const moving = 900;
const easing = "cubic-bezier(.2,.8,.2,1)";

/**
 * The line under the heading that has just been replaced or gone, kept
 * while the move up fades it out.
 */
function useGoneLine(line: string | null) {
  const [shown, setShown] = useState(line);
  const [gone, setGone] = useState<string | null>(null);
  if (line !== shown) {
    setShown(line);
    setGone(shown);
  }
  useEffect(() => {
    if (gone === null) return;
    const timer = window.setTimeout(() => setGone(null), moving);
    return () => window.clearTimeout(timer);
  }, [gone]);
  return gone;
}

/**
 * When the first device joins, or looking stops, the knot, the heading and
 * the button move from where they were to where they are now, straight up,
 * rather than jump: each starts drawn where it was and slides into place,
 * the heading at the size it was, coming to its new size on the way. The
 * line under the heading that goes fades out as it rises with them, and one
 * that comes fades in once they have nearly arrived. Positions are read from
 * the layout, which a transform doesn't change, so a move under way is
 * measured right. Where motion is reduced, they are simply there.
 */
function useMoveUp(isWaiting: boolean, line: string | null) {
  const knot = useRef<HTMLSpanElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const button = useRef<HTMLSpanElement>(null);
  // The lines under the heading, the one shown and one going, by their
  // words.
  const lines = useRef(new Map<string, HTMLElement>());
  const was = useRef(new Map<string, Place>());

  useLayoutEffect(() => {
    const middleOf = (element: HTMLElement) => {
      let top = element.offsetHeight / 2;
      for (
        let at: HTMLElement | null = element;
        at;
        at = at.offsetParent as HTMLElement | null
      ) {
        top += at.offsetTop;
      }
      return top;
    };
    const sizeOf = (element: HTMLElement) =>
      parseFloat(getComputedStyle(element).fontSize) || 1;
    const reduced =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;

    const parts: [string, HTMLElement | null][] = [
      ["knot", knot.current],
      ["heading", heading.current],
      ["button", button.current],
    ];
    for (const [key, element] of lines.current) {
      if (key.startsWith("line:")) parts.push([key, element]);
    }
    const now = new Map<string, Place>();
    for (const [key, element] of parts) {
      if (!element) continue;
      const here = {
        middle: middleOf(element),
        top: middleOf(element) - element.offsetHeight / 2,
        width: element.offsetWidth,
        size: sizeOf(element),
      };
      now.set(key, here);
      const before = was.current.get(key);
      if (reduced) continue;
      if (before === undefined) {
        // A line that has just come fades in as the others arrive.
        if (key.startsWith("line:") && was.current.size > 0)
          element.animate?.(
            [{ opacity: 0 }, { opacity: 0, offset: 0.6 }, { opacity: 1 }],
            { duration: moving, easing: "ease-out" },
          );
        continue;
      }
      const scale = before.size / here.size;
      if (before.middle === here.middle && scale === 1) continue;
      element.animate?.(
        [
          {
            transform: `translateY(${before.middle - here.middle}px) scale(${scale})`,
          },
          { transform: "none" },
        ],
        { duration: moving, easing },
      );
    }
    // A line that has gone rises from where it was as it fades.
    for (const [key, element] of lines.current) {
      if (!key.startsWith("gone:") || reduced) continue;
      const before = was.current.get(`line:${key.slice("gone:".length)}`);
      if (!before) continue;
      // As wide as it was, so its words keep their lines, and under the
      // heading, so the two rise together.
      element.style.width = `${before.width}px`;
      if (heading.current)
        element.style.top = `${heading.current.offsetTop + heading.current.offsetHeight}px`;
      const rise = before.top - (middleOf(element) - element.offsetHeight / 2);
      element.animate?.(
        [
          { transform: `translateY(${rise}px)`, opacity: 1 },
          { opacity: 0, offset: 0.5 },
          { transform: "none", opacity: 0 },
        ],
        { duration: moving, easing },
      );
    }
    was.current = now;
  }, [isWaiting, line]);

  const keep = (key: string) => (element: HTMLElement | null) => {
    if (element) lines.current.set(key, element);
    else lines.current.delete(key);
  };
  return {
    knot,
    heading,
    button,
    line: (words: string) => keep(`line:${words}`),
    gone: (words: string) => keep(`gone:${words}`),
  };
}

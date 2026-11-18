import type { DeviceInfo, JoinedDevice } from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { useLayoutEffect, useRef, type ReactNode } from "react";

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
  const at = useMoveUp(isWaiting);
  const kind = props.name ? `${props.name} devices` : "New devices";

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
        {(isWaiting || (!isLooking && state.why !== "failed")) && (
          <p className="m-0 mt-2 max-w-105 text-[14.5px] leading-[1.5] text-(--silver)">
            {isLooking
              ? `${kind} can join for ${lasting(props.seconds)}. When the time is up, you can start again.`
              : `${kind} can't join right now. Start again to give them another ${lasting(props.seconds)}.`}
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

/**
 * When the first device joins, the knot, the heading and the button move
 * from where they were to where they are now, straight up, rather than jump:
 * each starts drawn where it was and slides into place. Positions are read
 * from the layout, which a transform doesn't change, so a move under way is
 * measured right. Where motion is reduced, they are simply there.
 */
function useMoveUp(isWaiting: boolean) {
  const knot = useRef<HTMLSpanElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const button = useRef<HTMLSpanElement>(null);
  const was = useRef<Map<HTMLElement, number>>(new Map());

  useLayoutEffect(() => {
    const elements = [knot.current, heading.current, button.current].flatMap(
      (each) => (each ? [each] : []),
    );
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
    const reduced =
      typeof matchMedia === "function" &&
      matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const element of elements) {
      const now = middleOf(element);
      const before = was.current.get(element);
      was.current.set(element, now);
      if (before === undefined || before === now || reduced) continue;
      element.animate?.(
        [
          { transform: `translateY(${before - now}px)` },
          { transform: "translateY(0)" },
        ],
        { duration: 900, easing: "cubic-bezier(.2,.8,.2,1)" },
      );
    }
  }, [isWaiting]);

  return { knot, heading, button };
}

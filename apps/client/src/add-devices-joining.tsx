import type { DeviceInfo, JoinedDevice } from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
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

/** The devices that joined, less those removed here since. */
export const shownJoined = (joined: readonly JoinedDevice[]) =>
  joined.filter((each) => !(each.stage === "ready" && each.deviceId === null));

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
  const joined = shownJoined(props.joined);
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
  const entrances = useCardEntrances(new Set(joined.map(foundKey)), isWaiting);

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
        {[line, gone].map((words, index) => {
          if (words === null) return null;
          const isFading = index === 1;
          return (
            <p
              key={words}
              ref={isFading ? at.gone : at.line}
              aria-hidden={isFading || undefined}
              className={cn(
                "m-0 mt-2 max-w-105 text-[14.5px] leading-[1.5] text-(--silver)",
                isFading && "pointer-events-none absolute opacity-0",
              )}
            >
              {words}
            </p>
          );
        })}
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
            // With devices joined, what is left is to close, so Done is the
            // primary action and starting again is outlined.
            <Button
              variant={hasJoined ? "outline" : "default"}
              onClick={props.onStartAgain}
            >
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
          {joined.map((each) => {
            const key = foundKey(each);
            return (
              <JoinedCard
                key={key}
                joined={each}
                {...entrances.get(key)}
                device={props.devices.find(
                  (device) => device.id === each.deviceId,
                )}
                work={props.work}
              />
            );
          })}
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

const moveMs = 900;
const easing = "cubic-bezier(.2,.8,.2,1)";

/**
 * Only cards that start the move wait for it, each a little after the one
 * before; cards that come later rise in at once, however many come
 * together. Each card keeps the timing it came with.
 */
function useCardEntrances(keys: ReadonlySet<string>, isWaiting: boolean) {
  const [batch, setBatch] = useState(() => ({
    isWaiting,
    cards: new Map<string, { index: number; waitMs: number }>(),
  }));
  if (
    isWaiting !== batch.isWaiting ||
    keys.size !== batch.cards.size ||
    [...keys].some((key) => !batch.cards.has(key))
  ) {
    const waitMs = batch.isWaiting && !isWaiting ? moveMs / 2 : 0;
    const staggers = waitMs > 0 || batch.cards.size === 0;
    let index = 0;
    const cards = new Map(
      [...keys].map((key) => [
        key,
        batch.cards.get(key) ?? {
          index: staggers ? index++ : 0,
          waitMs,
        },
      ]),
    );
    setBatch({ isWaiting, cards });
  }
  return batch.cards;
}

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
    const timer = window.setTimeout(() => setGone(null), moveMs);
    return () => window.clearTimeout(timer);
  }, [gone]);
  return gone;
}

// Keep the line's current opacity if another transition interrupted its fade.
function stopFade(element: HTMLElement, fallback: number) {
  const animations = element.getAnimations?.() ?? [];
  if (animations.length === 0) return fallback;
  const opacity = Number(getComputedStyle(element).opacity);
  for (const animation of animations) animation.cancel();
  return opacity;
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
function useMoveUp(isWaiting: boolean, words: string | null) {
  const knot = useRef<HTMLSpanElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const button = useRef<HTMLSpanElement>(null);
  const line = useRef<HTMLParagraphElement>(null);
  const gone = useRef<HTMLParagraphElement>(null);
  const previous = useRef<{
    parts: { middle: number; size: number }[];
    line: { words: string | null; top: number; width: number } | null;
  }>(null);

  useLayoutEffect(() => {
    const topOf = (element: HTMLElement) => {
      let top = 0;
      for (
        let at: HTMLElement | null = element;
        at;
        at = at.offsetParent as HTMLElement | null
      ) {
        top += at.offsetTop;
      }
      return top;
    };
    const title = heading.current;
    if (!knot.current || !title || !button.current) return;

    const shown = line.current;
    if (shown) {
      shown.style.removeProperty("width");
      shown.style.removeProperty("top");
    }
    const elements = [knot.current, title, button.current];
    const measure = () => ({
      parts: elements.map((element) => ({
        middle: topOf(element) + element.offsetHeight / 2,
        size: parseFloat(getComputedStyle(element).fontSize) || 1,
      })),
      line: shown && { words, top: topOf(shown), width: shown.offsetWidth },
    });
    const before = previous.current;
    const now = measure();
    previous.current = now;
    // Resizing while waiting moves the starting point and can wrap the line.
    const rememberLayout = () => {
      previous.current = measure();
    };
    window.addEventListener("resize", rememberLayout);
    const stopWatching = () =>
      window.removeEventListener("resize", rememberLayout);
    if (
      !before ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return stopWatching;

    for (const [index, element] of elements.entries()) {
      const old = before.parts[index]!;
      const next = now.parts[index]!;
      if (old.middle === next.middle && old.size === next.size) continue;
      // A quick restart begins at the heading's current animated position.
      const transform = getComputedStyle(element).transform;
      const current =
        transform && transform !== "none"
          ? new DOMMatrixReadOnly(transform)
          : null;
      const shift = old.middle - next.middle + (current?.m42 ?? 0);
      const scale = (old.size / next.size) * (current?.m11 ?? 1);
      for (const animation of element.getAnimations?.() ?? [])
        animation.cancel();
      element.animate?.(
        [
          { transform: `translateY(${shift}px) scale(${scale})` },
          { transform: "none" },
        ],
        { duration: moveMs, easing },
      );
    }
    if (shown && before.line?.words !== words) {
      // A line that has just come fades in as the others arrive.
      const opacity = stopFade(shown, 0);
      shown.animate?.([{ opacity }, { opacity, offset: 0.6 }, { opacity: 1 }], {
        duration: moveMs,
        easing: "ease-out",
      });
    }
    const fading = gone.current;
    if (fading && before.line && before.line.words !== words) {
      const opacity = stopFade(fading, 1);
      if (opacity === 0) return stopWatching;
      // As wide as it was, so its words keep their lines, and under the
      // heading, so the two rise together.
      fading.style.width = `${before.line.width}px`;
      fading.style.top = `${title.offsetTop + title.offsetHeight}px`;
      const rise = before.line.top - topOf(fading);
      fading.animate?.(
        [
          { transform: `translateY(${rise}px)`, opacity },
          { opacity: 0, offset: 0.5 },
          { transform: "none", opacity: 0 },
        ],
        { duration: moveMs, easing },
      );
    }
    return stopWatching;
  }, [isWaiting, words]);

  return { knot, heading, button, line, gone };
}

import type { DeviceInfo, MediaCommand } from "@meetsanctum/app-sdk";
import { Button, LevelSlider } from "@meetsanctum/ui-sdk";
import {
  createLucideIcon,
  Minus,
  Pause,
  Play,
  Plus,
  Power,
  SkipBack,
  SkipForward,
  VolumeX,
} from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import { canPlayPause, isPlaying, type Media } from "./media";

// A media player's pages in its detail, on the veil's glass with no card:
// Playing, what it plays with its controls; a TV's Remote, its power above
// its volume's buttons; a speaker's Volume, mute above its level. Off or
// with nothing to play, Playing keeps its layout, dimmed and empty, so it
// shows what it will hold. Power is on Remote only.

/** A remote, which Lucide has none for: its body with a button near the top. */
export const RemoteIcon = createLucideIcon("remote", [
  ["rect", { x: "7", y: "2", width: "10", height: "20", rx: "3", key: "body" }],
  ["circle", { cx: "12", cy: "7.5", r: "2", key: "pad" }],
  ["path", { d: "M12 13h.01", key: "one" }],
  ["path", { d: "M12 16.5h.01", key: "two" }],
]);

type Props = {
  name: string;
  device: DeviceInfo;
  capability: Media;
  /** Offline: shown, with nothing to press. */
  disabled: boolean;
  failures?: number;
  /** The picture of what plays, once it has arrived (artwork.ts). */
  artwork?: string | null;
  /** Something plays with no picture to show: none, or one the core refused. */
  artworkMissing?: boolean;
  onCommand: (command: MediaCommand) => void;
};

const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const rest = String(whole % 60).padStart(2, "0");
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
    : `${minutes}:${rest}`;
};

// Where it is in what plays, counted on from when the player said so while
// it plays, each second.
function usePosition(capability: Media): number | null {
  // The reported position belongs to the reported activity, even while a
  // command is still waiting for the player to switch between play and pause.
  const { observed } = capability;
  const media = observed?.media;
  const isAdvancing =
    observed?.on !== false &&
    observed?.activity === "playing" &&
    media?.position !== undefined;
  const positionAt = media?.positionAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!isAdvancing || !positionAt) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isAdvancing, positionAt]);
  if (media?.position === undefined) return null;
  const since =
    isAdvancing && positionAt
      ? Math.max(0, (now - Date.parse(positionAt)) / 1000)
      : 0;
  const at = media.position + since;
  return media.duration === undefined ? at : Math.min(at, media.duration);
}

// What plays, under its title: a show's season and episode, a song's artist
// and album, and the app playing it.
function aboutWhatPlays(capability: Media): string | null {
  const state = capability.state;
  const media = state?.media;
  const episode =
    media?.season !== undefined && media.episode !== undefined
      ? `Season ${media.season}, episode ${media.episode}`
      : null;
  const parts = [
    media?.series ?? null,
    episode,
    episode ? null : (media?.artist ?? null),
    episode ? null : (media?.album ?? null),
    state?.app?.name ?? null,
  ].filter((each): each is string => each !== null && each !== media?.title);
  return parts.length > 0 ? [...new Set(parts)].join(" · ") : null;
}

// A picture the shell draws for something playing that has none to show,
// because its player gave none, the core refused it or it didn't load:
// warm, so it reads as something playing, not as nothing.
const missingArtwork =
  "radial-gradient(55% 60% at 36% 38%, rgb(226 84 112 / 80%) 0%, transparent 70%), radial-gradient(45% 50% at 86% 90%, rgb(242 166 92 / 90%) 0%, transparent 72%), linear-gradient(150deg, #7c2438 0%, #882a44 55%, #6f2136 100%)";
/** The veil's colour while that picture shows, as one taken from it. */
export const missingArtworkTint = "oklch(0.42 0.12 12)";

// The picture of what plays, in its own shape up to 300 by 264 px. Without
// one, it is a soft grey gradient the shell draws, saying "Nothing playing"
// while nothing does, or the warm one above when something plays with no
// picture; a song's is square, a film's or a show's as wide as a screen.
function Artwork(props: {
  square: boolean;
  nothing: boolean;
  missing: boolean;
  url?: string | null;
}) {
  const [ratio, setRatio] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  if (props.url && !props.nothing && !failed) {
    // The player's own picture in its own shape: as wide as the page beside
    // it allows, 300 px, or 264 px tall where it's taller than that.
    const shape = ratio ?? (props.square ? 1 : 16 / 9);
    return (
      <img
        src={props.url}
        alt=""
        onError={() => setFailed(true)}
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget;
          if (naturalWidth > 0 && naturalHeight > 0) {
            setRatio(naturalWidth / naturalHeight);
          }
        }}
        style={
          {
            aspectRatio: shape,
            "--artwork-width": `min(300px, ${Math.round(264 * shape)}px)`,
          } as CSSProperties
        }
        className="block w-full rounded-xl object-cover @min-[560px]:w-(--artwork-width)"
      />
    );
  }
  return (
    <div
      className={`grid w-full place-items-center overflow-hidden rounded-xl px-4 text-center ${props.square ? "aspect-square @min-[560px]:w-66" : "aspect-video @min-[560px]:w-75"}`}
      style={{
        background:
          !props.nothing && (props.missing || failed)
            ? missingArtwork
            : "radial-gradient(70% 90% at 22% 18%, rgb(255 255 255 / 16%) 0%, transparent 60%), radial-gradient(60% 80% at 85% 90%, rgb(120 128 150 / 28%) 0%, transparent 65%), linear-gradient(150deg, #55585f 0%, #3a3c41 55%, #2e2f33 100%)",
      }}
    >
      {props.nothing && (
        <span className="text-[26px] leading-8 font-medium tracking-[-0.01em] text-white/52">
          Nothing playing
        </span>
      )}
    </div>
  );
}

/** Playing: what plays and its controls, side by side where there is room. */
export function MediaPlaying(props: Props) {
  const { capability, onCommand } = props;
  const state = capability.state;
  const { playback } = capability.features;
  const playing = isPlaying(capability);
  const nothing = !state || state.on === false || state.activity === "idle";
  const able = !props.disabled && !nothing;
  const canToggle = !props.disabled && canPlayPause(capability);
  const position = usePosition(capability);
  const duration = state?.media?.duration;
  const canSeek =
    able && duration !== undefined && duration > 0 && playback.includes("seek");
  const [seeking, setSeeking] = useState<number | null>(null);
  const seekPointer = useRef<number | null>(null);
  const seekTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const shownAt = canSeek ? (seeking ?? position) : position;
  const page = useRef<HTMLDivElement>(null);
  const title = nothing ? null : (state?.media?.title ?? null);
  const about = nothing ? null : aboutWhatPlays(capability);
  const square =
    state?.media?.type === "music" ||
    (state?.media?.type === undefined &&
      (props.device.type === "speaker" ||
        props.device.type === "smart-speaker"));

  // Space is a shortcut only while Playing is the visible page.
  const toggle = useRef<(() => void) | null>(null);
  toggle.current = canToggle
    ? () => onCommand({ activity: playing ? "paused" : "playing" })
    : null;
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (
        event.key !== " " ||
        event.repeat ||
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        !toggle.current ||
        !page.current ||
        page.current.closest('[inert], [role="dialog"][data-state="closed"]')
      )
        return;
      const target = event.target;
      if (
        target instanceof Element &&
        (target.closest('[role="dialog"]') !==
          page.current.closest('[role="dialog"]') ||
          target.closest(
            'input, textarea, select, button, a[href], summary, [contenteditable], [role="button"], [role="slider"]',
          ))
      )
        return;
      event.preventDefault();
      toggle.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (canSeek) return;
    seekPointer.current = null;
    clearTimeout(seekTimeout.current);
    setSeeking(null);
  }, [canSeek]);
  useEffect(() => {
    if (seekPointer.current === null) setSeeking(null);
  }, [
    capability.observed?.media?.position,
    capability.observed?.media?.positionAt,
    props.failures,
  ]);
  useEffect(() => () => clearTimeout(seekTimeout.current), []);

  const seek = (to: number) => {
    setSeeking(to);
    clearTimeout(seekTimeout.current);
    seekTimeout.current = setTimeout(() => setSeeking(null), 3000);
    onCommand({ position: to });
  };
  const cancelSeek = (event: PointerEvent<HTMLDivElement>) => {
    if (seekPointer.current !== event.pointerId) return;
    seekPointer.current = null;
    setSeeking(null);
  };

  return (
    <div
      ref={page}
      className="@container flex w-[760px] max-w-full justify-center"
    >
      <div className="grid w-full items-center gap-5 px-1 pt-2 @min-[560px]:grid-cols-[minmax(0,1fr)_auto] @min-[560px]:gap-10 @min-[560px]:pt-7">
        <div className="flex min-w-0 flex-col gap-5">
          {(title || about) && (
            <div className="flex flex-col gap-0.5">
              {title && (
                <p className="m-0 text-[22px] leading-7 font-medium text-balance">
                  {title}
                </p>
              )}
              {about && (
                <p className="m-0 text-[15px] leading-5 text-white/64">
                  {about}
                </p>
              )}
            </div>
          )}
          <div
            className={`flex flex-col gap-1 ${duration === undefined || !able ? "opacity-45" : ""}`}
          >
            <div className="relative h-1.5 rounded-full bg-white/22 has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/50">
              {duration !== undefined && shownAt !== null && able && (
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 rounded-full bg-white"
                  style={{ width: `${(shownAt / (duration || 1)) * 100}%` }}
                />
              )}
              {canSeek && (
                <div
                  onPointerDown={(event) => {
                    event.stopPropagation();
                    if (
                      event.button !== 0 ||
                      event.isPrimary === false ||
                      seekPointer.current !== null
                    )
                      return;
                    // Use the visible rail's coordinates in every browser,
                    // including when the drag begins away from the thumb.
                    clearTimeout(seekTimeout.current);
                    seekPointer.current = event.pointerId;
                    event.currentTarget.setPointerCapture?.(event.pointerId);
                    setSeeking(seekAt(event, duration));
                  }}
                  onPointerMove={(event) => {
                    if (seekPointer.current !== event.pointerId) return;
                    setSeeking(seekAt(event, duration));
                  }}
                  onPointerUp={(event) => {
                    if (seekPointer.current !== event.pointerId) return;
                    seekPointer.current = null;
                    seek(seekAt(event, duration));
                  }}
                  onPointerCancel={cancelSeek}
                  onLostPointerCapture={cancelSeek}
                  className="absolute inset-x-0 -top-2 h-6 w-full cursor-pointer [touch-action:none]"
                >
                  <input
                    type="range"
                    min={0}
                    max={duration}
                    step={1}
                    value={shownAt ?? 0}
                    aria-label={`Where ${props.name} is`}
                    aria-valuetext={`${clock(shownAt ?? 0)} of ${clock(duration)}`}
                    onChange={(event) => {
                      if (seekPointer.current === null) {
                        seek(event.currentTarget.valueAsNumber);
                      }
                    }}
                    className="pointer-events-none absolute inset-0 size-full opacity-0"
                  />
                </div>
              )}
            </div>
            <div className="flex justify-between text-xs text-white/64 tabular-nums">
              <span>{shownAt !== null && able ? clock(shownAt) : "–:––"}</span>
              <span>
                {duration !== undefined && shownAt !== null && able
                  ? `−${clock(duration - shownAt)}`
                  : "–:––"}
              </span>
            </div>
          </div>
          <div
            className={`flex items-center px-4 ${playback.includes("previous") || playback.includes("next") ? "justify-between" : "justify-center"}`}
          >
            {playback.includes("previous") && (
              <Button
                variant="ghost"
                size="round"
                aria-label="Previous"
                disabled={!able}
                onClick={() => onCommand({ playback: "previous" })}
              >
                <SkipBack aria-hidden="true" fill="currentColor" />
              </Button>
            )}
            <Button
              variant="glass"
              size="round-lg"
              aria-label={`${playing ? "Pause" : "Play"} ${props.name}`}
              disabled={!canToggle}
              onClick={() => toggle.current?.()}
            >
              {playing ? (
                <Pause aria-hidden="true" fill="currentColor" />
              ) : (
                <Play aria-hidden="true" fill="currentColor" />
              )}
            </Button>
            {playback.includes("next") && (
              <Button
                variant="ghost"
                size="round"
                aria-label="Next"
                disabled={!able}
                onClick={() => onCommand({ playback: "next" })}
              >
                <SkipForward aria-hidden="true" fill="currentColor" />
              </Button>
            )}
          </div>
        </div>
        <div className="order-first grid place-items-center self-stretch @min-[560px]:order-none">
          <Artwork
            key={props.artwork}
            square={square}
            nothing={nothing}
            missing={props.artworkMissing ?? false}
            url={props.artwork}
          />
        </div>
      </div>
    </div>
  );
}

function seekAt(event: PointerEvent<HTMLDivElement>, duration: number) {
  const { left, width } = event.currentTarget.getBoundingClientRect();
  const position = ((event.clientX - left) / (width || 1)) * duration;
  return Math.min(duration, Math.max(0, Math.round(position)));
}

// A small round toggle above a page's volume: a TV's power, a speaker's
// mute, White while on or muted.
function Toggle(props: {
  label: string;
  pressed: boolean;
  disabled: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="glass"
      size="round"
      aria-label={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  );
}

// The volume's + over its −, one shape the size of the volume's level, for
// a player that can only step it. Holding either repeats it.
function VolumeSteps(props: {
  name: string;
  disabled: boolean;
  onStep: (step: "up" | "down") => void;
}) {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeated = useRef(false);
  const pointer = useRef<number | null>(null);
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    pointer.current = null;
  };
  useEffect(() => stop, []);
  const holding = (step: "up" | "down") => ({
    onPointerDown: (event: PointerEvent<HTMLButtonElement>) => {
      // A hold is the button's own, never the pages' swipe.
      event.stopPropagation();
      if (props.disabled || event.button !== 0 || event.isPrimary === false)
        return;
      if (pointer.current !== null) return;
      repeated.current = false;
      pointer.current = event.pointerId;
      const button = event.currentTarget;
      const again = (wait: number) => {
        timer.current = setTimeout(() => {
          if (
            button.disabled ||
            button.closest('[inert], [role="dialog"][data-state="closed"]')
          ) {
            stop();
            return;
          }
          repeated.current = true;
          props.onStep(step);
          again(300);
        }, wait);
      };
      again(400);
    },
    onPointerUp: endHold,
    onPointerLeave: endHold,
    onPointerCancel: endHold,
    onClick: (event: MouseEvent<HTMLButtonElement>) => {
      if (event.detail === 0 || !repeated.current) props.onStep(step);
    },
  });
  const endHold = (event: PointerEvent<HTMLButtonElement>) => {
    if (pointer.current === event.pointerId) stop();
  };
  return (
    <div
      role="group"
      aria-label={`${props.name} volume`}
      className="flex flex-col"
    >
      <Button
        variant="glass"
        size="step"
        aria-label="Turn the volume up"
        disabled={props.disabled}
        {...holding("up")}
      >
        <Plus aria-hidden="true" />
      </Button>
      <Button
        variant="glass"
        size="step"
        aria-label="Turn the volume down"
        disabled={props.disabled}
        {...holding("down")}
      >
        <Minus aria-hidden="true" />
      </Button>
    </div>
  );
}

/** Remote, a TV's second page: its power above its volume's + and −. */
export function MediaRemote(props: Props) {
  const { capability, onCommand } = props;
  const on = capability.state?.on === true;
  const { volume } = capability.features;
  return (
    <div className="mt-4 flex flex-col items-center gap-5">
      {capability.features.power && (
        <Toggle
          label={`${on ? "Turn off" : "Turn on"} ${props.name}`}
          pressed={on}
          disabled={props.disabled}
          onClick={() => onCommand({ on: !on })}
        >
          <Power aria-hidden="true" />
        </Toggle>
      )}
      {volume !== null && (
        <VolumeSteps
          name={props.name}
          disabled={props.disabled || capability.state?.on === false}
          onStep={(volumeStep) => onCommand({ volumeStep })}
        />
      )}
    </div>
  );
}

/** Volume, a speaker's second page: mute above its level, as Remote is laid out. */
export function MediaVolume(props: Props) {
  const { capability, onCommand } = props;
  const muted = capability.state?.muted === true;
  return (
    <div className="mt-4 flex flex-col items-center gap-5">
      {capability.features.mute && (
        <Toggle
          label={`Mute ${props.name}`}
          pressed={muted}
          disabled={props.disabled}
          onClick={() => onCommand({ muted: !muted })}
        >
          <VolumeX aria-hidden="true" />
        </Toggle>
      )}
      {capability.features.volume === "level" ? (
        <LevelSlider
          label={`${props.name} volume`}
          level={capability.state?.volume ?? 0}
          fill="#ffffff"
          valueText={(level) => `${level}%`}
          disabled={props.disabled}
          failures={props.failures}
          onLevel={(volume) => onCommand({ volume })}
        />
      ) : (
        capability.features.volume === "steps" && (
          <VolumeSteps
            name={props.name}
            disabled={props.disabled}
            onStep={(volumeStep) => onCommand({ volumeStep })}
          />
        )
      )}
    </div>
  );
}

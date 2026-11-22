import type { DeviceInfo, MediaCommand } from "@meetsanctum/app-sdk";
import { LevelSlider } from "@meetsanctum/ui-sdk";
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
  type PointerEvent,
  type ReactNode,
} from "react";

import { canPlayPause, type Media } from "./media";

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
  const media = capability.state?.media;
  const playing = capability.state?.activity === "playing";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!playing || media?.position === undefined) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [playing, media?.position]);
  if (media?.position === undefined) return null;
  const since =
    playing && media.positionAt
      ? Math.max(0, (now - Date.parse(media.positionAt)) / 1000)
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
    episode,
    episode ? null : (media?.artist ?? null),
    episode ? null : (media?.album ?? null),
    state?.app?.name ?? null,
  ].filter((each): each is string => each !== null && each !== media?.title);
  return parts.length > 0 ? parts.join(" · ") : null;
}

// The picture of what plays. Until a player hands one over, it is a soft
// grey gradient the shell draws, saying "Nothing playing" while nothing
// does; a song's is square, a film's or a show's as wide as a screen.
function Artwork(props: { square: boolean; nothing: boolean }) {
  return (
    <div
      className={`grid w-full place-items-center overflow-hidden rounded-xl px-4 text-center ${props.square ? "aspect-square @min-[560px]:w-66" : "aspect-video @min-[560px]:w-75"}`}
      style={{
        background:
          "radial-gradient(70% 90% at 22% 18%, rgb(255 255 255 / 16%) 0%, transparent 60%), radial-gradient(60% 80% at 85% 90%, rgb(120 128 150 / 28%) 0%, transparent 65%), linear-gradient(150deg, #55585f 0%, #3a3c41 55%, #2e2f33 100%)",
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

function RoundButton(props: {
  label: string;
  disabled?: boolean;
  big?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      disabled={props.disabled}
      onClick={props.onClick}
      className={`grid shrink-0 place-items-center rounded-full text-white outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-40 ${props.big ? "size-18 bg-white/16" : "size-12"}`}
    >
      {props.children}
    </button>
  );
}

/** Playing: what plays and its controls, side by side where there is room. */
export function MediaPlaying(props: Props) {
  const { capability, onCommand } = props;
  const state = capability.state;
  const { playback } = capability.features;
  const playing = state?.activity === "playing";
  const nothing =
    !state || state.on === false || (state.activity === "idle" && !state.media);
  const able = !props.disabled && !nothing;
  const canToggle = !props.disabled && canPlayPause(capability);
  const position = usePosition(capability);
  const duration = state?.media?.duration;
  const [seeking, setSeeking] = useState<number | null>(null);
  const shownAt = seeking ?? position;
  const title = nothing ? null : (state?.media?.title ?? null);
  const about = nothing ? null : aboutWhatPlays(capability);
  const square =
    state?.media?.type === "music" ||
    (state?.media?.type === undefined &&
      (props.device.type === "speaker" ||
        props.device.type === "smart-speaker"));

  // Space plays or pauses while the detail is open, as on any player.
  const toggle = useRef<() => void>(() => undefined);
  toggle.current = () => {
    if (canToggle) onCommand({ activity: playing ? "paused" : "playing" });
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== " " || event.repeat) return;
      // A field or a button takes its own Space.
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest("input, textarea, button, [contenteditable]")
      )
        return;
      event.preventDefault();
      toggle.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const seek = (to: number) => {
    setSeeking(null);
    onCommand({ position: Math.round(to) });
  };

  return (
    <div className="@container flex w-[760px] max-w-full justify-center">
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
            <div className="relative h-1.5 rounded-full bg-white/22">
              {duration !== undefined && shownAt !== null && able && (
                <span
                  aria-hidden="true"
                  className="absolute inset-y-0 left-0 rounded-full bg-white"
                  style={{ width: `${(shownAt / (duration || 1)) * 100}%` }}
                />
              )}
              {playback.includes("seek") && duration !== undefined && able && (
                <input
                  type="range"
                  min={0}
                  max={duration}
                  step={1}
                  value={shownAt ?? 0}
                  aria-label={`Where ${props.name} is`}
                  aria-valuetext={`${clock(shownAt ?? 0)} of ${clock(duration)}`}
                  onChange={(event) => setSeeking(Number(event.target.value))}
                  onPointerUp={(event) =>
                    seek(Number(event.currentTarget.value))
                  }
                  onKeyUp={(event) => seek(Number(event.currentTarget.value))}
                  onPointerDown={(event) => event.stopPropagation()}
                  className="absolute inset-x-0 -top-2 h-6 w-full cursor-pointer opacity-0"
                />
              )}
            </div>
            <div className="flex justify-between text-xs text-white/64 tabular-nums">
              <span>
                {duration !== undefined && shownAt !== null && able
                  ? clock(shownAt)
                  : "–:––"}
              </span>
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
              <RoundButton
                label="Previous"
                disabled={!able}
                onClick={() => onCommand({ playback: "previous" })}
              >
                <SkipBack
                  aria-hidden="true"
                  className="size-6.5"
                  fill="currentColor"
                />
              </RoundButton>
            )}
            <RoundButton
              big
              label={`${playing ? "Pause" : "Play"} ${props.name}`}
              disabled={!canToggle}
              onClick={() => toggle.current()}
            >
              {playing ? (
                <Pause
                  aria-hidden="true"
                  className="size-7.5"
                  fill="currentColor"
                />
              ) : (
                <Play
                  aria-hidden="true"
                  className="size-7.5"
                  fill="currentColor"
                />
              )}
            </RoundButton>
            {playback.includes("next") && (
              <RoundButton
                label="Next"
                disabled={!able}
                onClick={() => onCommand({ playback: "next" })}
              >
                <SkipForward
                  aria-hidden="true"
                  className="size-6.5"
                  fill="currentColor"
                />
              </RoundButton>
            )}
          </div>
        </div>
        <div className="order-first grid place-items-center self-stretch @min-[560px]:order-none">
          <Artwork square={square} nothing={nothing} />
        </div>
      </div>
    </div>
  );
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
    <button
      type="button"
      aria-label={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
      className="grid size-12 place-items-center rounded-full bg-white/14 text-white outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-40 aria-pressed:bg-white aria-pressed:text-(--carbon)"
    >
      {props.children}
    </button>
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
  const stop = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  const holding = (step: "up" | "down") => ({
    onPointerDown: (event: PointerEvent) => {
      // A hold is the button's own, never the pages' swipe.
      event.stopPropagation();
      if (props.disabled || event.button !== 0) return;
      stop();
      const again = (wait: number) => {
        timer.current = setTimeout(() => {
          props.onStep(step);
          again(300);
        }, wait);
      };
      again(400);
    },
    onPointerUp: stop,
    onPointerLeave: stop,
    onPointerCancel: stop,
  });
  const half =
    "grid flex-1 place-items-center text-white outline-none focus-visible:bg-white/10 disabled:opacity-40";
  return (
    <div
      role="group"
      aria-label={`${props.name} volume`}
      className="flex h-72 w-24 flex-col overflow-hidden rounded-2xl bg-white/14"
    >
      <button
        type="button"
        aria-label="Turn the volume up"
        disabled={props.disabled}
        onClick={() => props.onStep("up")}
        {...holding("up")}
        className={half}
      >
        <Plus aria-hidden="true" className="size-7" />
      </button>
      <button
        type="button"
        aria-label="Turn the volume down"
        disabled={props.disabled}
        onClick={() => props.onStep("down")}
        {...holding("down")}
        className={half}
      >
        <Minus aria-hidden="true" className="size-7" />
      </button>
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
          <Power aria-hidden="true" className="size-5.5" />
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
          <VolumeX aria-hidden="true" className="size-5.5" />
        </Toggle>
      )}
      {capability.features.volume === "level" ? (
        <LevelSlider
          label={`${props.name} volume`}
          level={capability.state?.volume ?? 0}
          fill="#ffffff"
          valueText={(level) => `${level}%`}
          disabled={props.disabled}
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

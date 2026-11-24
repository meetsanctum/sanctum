import type { DeviceInfo, MediaCommand } from "@meetsanctum/app-sdk";
import { Button, LevelSlider, useShowFailed } from "@meetsanctum/ui-sdk";
import {
  createLucideIcon,
  Mic,
  MicOff,
  Minus,
  Pause,
  Play,
  Plus,
  Power,
  SkipBack,
  SkipForward,
  Volume2,
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
// its volume's buttons; a speaker's Volume, mute and, on a smart speaker,
// its microphones' mute above its level. Off or
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
// warm, so it reads as something playing, not as nothing. The veil takes
// its colour as it would one taken from a picture.
const missingArtwork =
  "radial-gradient(55% 60% at 36% 38%, rgb(226 84 112 / 80%) 0%, transparent 70%), radial-gradient(45% 50% at 86% 90%, rgb(242 166 92 / 90%) 0%, transparent 72%), linear-gradient(150deg, #7c2438 0%, #882a44 55%, #6f2136 100%)";
export const missingArtworkTint = "oklch(0.42 0.12 12)";

// The picture of what plays, in its own shape up to 300 by 264 px. The
// placeholder is warm if artwork is missing and grey while it loads or
// nothing plays. A song's placeholder is square, a film's or a show's as
// wide as a screen.
function Artwork(props: {
  square: boolean;
  nothing: boolean;
  isMissing: boolean;
  url: string | null;
  onError: (url: string) => void;
}) {
  const [ratio, setRatio] = useState<number | null>(null);
  const picture = props.nothing ? null : props.url;
  // As wide as the page beside it allows, 300 px, or 264 px tall where it's
  // taller than that: the player's own picture by its own shape.
  const shape = (picture && ratio) || (props.square ? 1 : 16 / 9);
  const frame = {
    style: {
      aspectRatio: shape,
      "--artwork-width": `min(300px, ${Math.round(264 * shape)}px)`,
    } as CSSProperties,
    className: "w-full rounded-xl @min-[560px]:w-(--artwork-width)",
  };
  if (picture) {
    return (
      <img
        src={picture}
        alt=""
        onError={() => props.onError(picture)}
        onLoad={(event) => {
          const { naturalWidth, naturalHeight } = event.currentTarget;
          if (naturalWidth > 0 && naturalHeight > 0) {
            setRatio(naturalWidth / naturalHeight);
          }
        }}
        style={frame.style}
        className={`${frame.className} block object-cover`}
      />
    );
  }
  return (
    <div
      aria-hidden="true"
      style={{
        ...frame.style,
        background:
          !props.nothing && props.isMissing
            ? missingArtwork
            : "radial-gradient(70% 90% at 22% 18%, rgb(255 255 255 / 16%) 0%, transparent 60%), radial-gradient(60% 80% at 85% 90%, rgb(120 128 150 / 28%) 0%, transparent 65%), linear-gradient(150deg, #55585f 0%, #3a3c41 55%, #2e2f33 100%)",
      }}
      className={frame.className}
    />
  );
}

// What plays, by its title over what it is from.
function Heading(props: { title: string | null; about: string | null }) {
  return (
    <div className="flex flex-col gap-0.5">
      {props.title && (
        <p className="m-0 text-[22px] leading-7 font-medium text-balance">
          {props.title}
        </p>
      )}
      {props.about && (
        <p className="m-0 text-[15px] leading-5 text-white/64">{props.about}</p>
      )}
    </div>
  );
}

// Where it is in what plays: a bar, the clock under it hanging below the
// bar's own line, so what is laid out by the bar lines up with the bar
// itself. Where the player seeks, the bar is a slider.
function Timeline(
  props: Pick<Props, "capability" | "failures" | "name" | "onCommand"> & {
    canControl: boolean;
  },
) {
  const { capability, onCommand } = props;
  const position = usePosition(capability);
  const duration = capability.state?.media?.duration;
  const canSeek =
    props.canControl &&
    duration !== undefined &&
    duration > 0 &&
    capability.features.playback.includes("seek");
  const [seeking, setSeeking] = useState<number | null>(null);
  const seekPointer = useRef<number | null>(null);
  const seekTimeout = useRef<ReturnType<typeof setTimeout>>(undefined);
  const shownAt = canSeek ? (seeking ?? position) : position;
  const hasPosition = props.canControl && shownAt !== null;

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
      className={`relative isolate h-1.5 rounded-full bg-white/22 has-[input:focus-visible]:ring-3 has-[input:focus-visible]:ring-ring/50 ${duration === undefined || !props.canControl ? "opacity-45" : ""}`}
    >
      {duration !== undefined && hasPosition && (
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
          className="absolute inset-x-0 -top-2 z-10 h-6 w-full cursor-pointer [touch-action:none]"
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
      {/* The seek hit area sits above the clock where they overlap. */}
      <div className="absolute inset-x-0 top-full mt-1 flex justify-between text-xs text-white/64 tabular-nums">
        <span>{hasPosition ? clock(shownAt) : "–:––"}</span>
        <span>
          {duration !== undefined && hasPosition
            ? `−${clock(duration - shownAt)}`
            : "–:––"}
        </span>
      </div>
    </div>
  );
}

function seekAt(event: PointerEvent<HTMLDivElement>, duration: number) {
  const { left, width } = event.currentTarget.getBoundingClientRect();
  const position = ((event.clientX - left) / (width || 1)) * duration;
  return Math.min(duration, Math.max(0, Math.round(position)));
}

// Play or pause in the middle, between previous and next where the player
// skips.
function Transport(props: {
  name: string;
  playback: Readonly<Media["features"]["playback"]>;
  isPlaying: boolean;
  canControl: boolean;
  canToggle: boolean;
  onToggle: () => void;
  onCommand: (command: MediaCommand) => void;
}) {
  const skip = (step: "previous" | "next") =>
    props.playback.includes(step) && (
      <Button
        variant="ghost"
        size="round"
        aria-label={step === "previous" ? "Previous" : "Next"}
        disabled={!props.canControl}
        onClick={() => props.onCommand({ playback: step })}
      >
        {step === "previous" ? (
          <SkipBack aria-hidden="true" fill="currentColor" />
        ) : (
          <SkipForward aria-hidden="true" fill="currentColor" />
        )}
      </Button>
    );
  const hasSkipButtons =
    props.playback.includes("previous") || props.playback.includes("next");
  return (
    <div
      className={`flex items-center px-4 ${hasSkipButtons ? "justify-between" : "justify-center"}`}
    >
      {skip("previous")}
      <Button
        variant="glass"
        size="round-lg"
        aria-label={`${props.isPlaying ? "Pause" : "Play"} ${props.name}`}
        disabled={!props.canToggle}
        onClick={props.onToggle}
      >
        {props.isPlaying ? (
          <Pause aria-hidden="true" fill="currentColor" />
        ) : (
          <Play aria-hidden="true" fill="currentColor" />
        )}
      </Button>
      {skip("next")}
    </div>
  );
}

/**
 * Playing: what plays and its controls, side by side where there is room,
 * one layout for every player and whatever it plays: a song, a show, a film
 * or nothing.
 */
export function MediaPlaying(
  props: Props & {
    artwork: string | null;
    isArtworkMissing: boolean;
    onArtworkError: (url: string) => void;
  },
) {
  const { capability, onCommand } = props;
  const state = capability.state;
  const playing = isPlaying(capability);
  const nothing = !state || state.on === false || state.activity === "idle";
  const canControl = !props.disabled && !nothing;
  const canToggle = !props.disabled && canPlayPause(capability);
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

  return (
    <div
      ref={page}
      className="@container flex w-[760px] max-w-full justify-center"
    >
      {/* Side by side, the bar's column is as wide as it is beside the
          widest picture, 300 px, so the bar keeps one length whatever plays,
          and the picture is centred in the column beside it. */}
      <div className="grid w-full items-center gap-5 px-1 pt-2 @min-[560px]:grid-cols-[calc(100%_-_300px_-_--spacing(10))_1fr] @min-[560px]:gap-10 @min-[560px]:pt-7">
        {/* The bar is on the picture's middle line whatever is above or
            below it: the rows above and below the bar are as tall as each
            other, and the column is as tall as the picture. What plays is
            centred in the space above the bar, at least 20 px from it. */}
        <div className="flex min-w-0 flex-col @min-[560px]:grid @min-[560px]:grid-rows-[1fr_auto_1fr] @min-[560px]:self-stretch">
          {(title || about) && (
            <div className="pb-5 @min-[560px]:self-center @min-[560px]:py-5">
              <Heading title={title} about={about} />
            </div>
          )}
          <div className="@min-[560px]:row-start-2">
            <Timeline
              capability={capability}
              canControl={canControl}
              failures={props.failures}
              name={props.name}
              onCommand={onCommand}
            />
          </div>
          {/* Below the bar's clock: 4 px, its 16 px line and 20 px. */}
          <div className="mt-10 @min-[560px]:row-start-3 @min-[560px]:self-start">
            <Transport
              name={props.name}
              playback={capability.features.playback}
              isPlaying={playing}
              canControl={canControl}
              canToggle={canToggle}
              onToggle={() => toggle.current?.()}
              onCommand={onCommand}
            />
          </div>
        </div>
        <div className="order-first grid place-items-center self-stretch @min-[560px]:order-none">
          <Artwork
            key={props.artwork}
            square={square}
            nothing={nothing}
            isMissing={props.isArtworkMissing}
            url={props.artwork}
            onError={props.onArtworkError}
          />
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
  /** Taps that didn't work, each shown once: a red wash and a shake. */
  failures?: number;
  onFailed?: () => void;
  children: ReactNode;
}) {
  const { surface, wash } = useShowFailed(props.failures, props.onFailed);
  return (
    <Button
      ref={surface}
      variant="glass"
      size="round"
      aria-label={props.label}
      aria-pressed={props.pressed}
      disabled={props.disabled}
      onClick={props.onClick}
      className="relative"
    >
      <span
        ref={wash}
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-[inherit] bg-(--danger) opacity-0"
      />
      <span className="relative grid place-items-center">{props.children}</span>
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

// Microphone mute shows what the speaker last reported while a change is
// on its way. A failed change shakes the button and announces the failure.
export function MicrophonesToggle(props: {
  name: string;
  muted: boolean;
  disabled: boolean;
  failures?: number;
  onMute: (muted: boolean) => void;
}) {
  const { muted } = props;
  const [announcement, setAnnouncement] = useState(0);
  return (
    <>
      <Toggle
        label={`Mute ${props.name}'s microphones`}
        pressed={muted}
        disabled={props.disabled}
        failures={props.failures}
        onFailed={() => setAnnouncement((count) => count + 1)}
        onClick={() => props.onMute(!muted)}
      >
        {muted ? <MicOff aria-hidden="true" /> : <Mic aria-hidden="true" />}
      </Toggle>
      <span role="alert" className="sr-only">
        {announcement > 0 && (
          <span key={announcement}>Couldn't change the microphone mute.</span>
        )}
      </span>
    </>
  );
}

/**
 * Volume, a speaker's second page: mute, and a smart speaker's microphones'
 * mute beside it where Sanctum can mute them, above its level, as Remote is
 * laid out.
 */
export function MediaVolume(props: Props & { microphones?: ReactNode }) {
  const { capability, microphones, onCommand } = props;
  const muted = capability.state?.muted === true;
  return (
    <div className="mt-4 flex flex-col items-center gap-5">
      {(capability.features.mute || microphones) && (
        <div className="flex gap-5">
          {capability.features.mute && (
            <Toggle
              label={`Mute ${props.name}`}
              pressed={muted}
              disabled={props.disabled}
              onClick={() => onCommand({ muted: !muted })}
            >
              {muted ? (
                <VolumeX aria-hidden="true" />
              ) : (
                <Volume2 aria-hidden="true" />
              )}
            </Toggle>
          )}
          {microphones}
        </div>
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

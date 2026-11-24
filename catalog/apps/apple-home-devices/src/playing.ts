import { createHash } from "node:crypto";

import type { MediaActivity, MediaState } from "@meetsanctum/app-sdk";

import type { Playing } from "./boxes.js";

// What a box says it plays, as the media kind takes it. Each field is
// checked against the kind's limits first: one field out of range would
// refuse the whole report, so such a field is left out instead.

type Media = NonNullable<MediaState["media"]>;
type App = NonNullable<MediaState["app"]>;

const maxWords = 256;
const maxSeconds = 1_000_000;
// A box whose clock runs ahead says it measured a position in the future,
// which a client would count back from; past this, it's taken as now.
const clockSlackMs = 5_000;

function words(text: string | undefined) {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return undefined;
  return trimmed.length > maxWords ? trimmed.slice(0, maxWords) : trimmed;
}

const seconds = (value: number | undefined) =>
  value !== undefined && Number.isFinite(value) && value >= 0
    ? Math.min(value, maxSeconds)
    : undefined;

const whole = (value: number | undefined, most: number) =>
  value !== undefined && Number.isInteger(value) && value >= 0 && value <= most
    ? value
    : undefined;

/** The item that plays, for telling one from the next. */
export function itemOf(playing: Playing) {
  const app = playing.app?.id ?? "";
  const identity = playing.contentId
    ? [app, "content", playing.contentId]
    : playing.uniqueId
      ? [app, "unique", playing.uniqueId]
      : [
          app,
          playing.title,
          playing.artist,
          playing.series,
          playing.season,
          playing.episode,
          Math.round(playing.duration ?? 0),
        ];
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

/** A fixed-size key for the item's current artwork. */
export function artworkOf(playing: Playing, item = itemOf(playing)) {
  return playing.artworkId
    ? createHash("sha256").update(item).update(playing.artworkId).digest("hex")
    : item;
}

/**
 * What it's doing: the box's own state. Seeking keeps what the same item
 * was doing; stopped is idle, since a stopped film won't resume.
 */
export function activityOf(
  state: Playing["state"],
  item: string,
  before: { item: string; activity: MediaActivity } | null,
): MediaActivity {
  switch (state) {
    case "playing":
      return "playing";
    case "paused":
      return "paused";
    case "seeking":
      return before?.item === item && before.activity !== "idle"
        ? before.activity
        : "playing";
    case "stopped":
    case "unknown":
      return "idle";
  }
}

export function appOf(playing: Playing): App | null {
  if (!playing.app) return null;
  const id = playing.app.id.slice(0, maxWords);
  const name = words(playing.app.name) ?? words(id);
  return id && name ? { id, name } : null;
}

/** What plays, or null where the box says nothing of it. */
export function mediaOf(playing: Playing, now: number): Media | null {
  const series = words(playing.series);
  const media: Media = {
    title: words(playing.title),
    artist: words(playing.artist),
    album: words(playing.album),
    series,
    season: whole(playing.season, 10_000),
    episode: whole(playing.episode, 100_000),
    type:
      playing.kind === "music"
        ? "music"
        : playing.kind === "video"
          ? series
            ? "episode"
            : "video"
          : undefined,
  };
  const duration = seconds(playing.duration);
  if (duration !== undefined && duration > 0) media.duration = duration;
  const position = seconds(playing.position);
  if (position !== undefined) {
    media.position =
      media.duration === undefined
        ? position
        : Math.min(position, media.duration);
    if (playing.positionAt !== undefined) {
      const at =
        playing.positionAt > now + clockSlackMs ? now : playing.positionAt;
      const date = new Date(at);
      if (Number.isFinite(date.getTime()))
        media.positionAt = date.toISOString();
    }
  }
  const said = Object.fromEntries(
    Object.entries(media).filter(([, value]) => value !== undefined),
  ) as Media;
  const tells = Object.keys(said).some((field) => field !== "type");
  return tells ? said : null;
}

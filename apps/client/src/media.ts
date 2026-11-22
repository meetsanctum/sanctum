import type {
  CapabilityInfo,
  DeviceInfo,
  DeviceType,
} from "@meetsanctum/app-sdk";
import type { Tile } from "@meetsanctum/ui-sdk";

// What media players say, in words: on a player's tile, in its detail and
// in Media's summary. A player says what is playing by its title, or by the
// app playing it where it gives no title.

export type Media = Extract<CapabilityInfo, { kind: "media" }>;
type MediaState = NonNullable<Media["state"]>;

export const isMedia = (capability: CapabilityInfo): capability is Media =>
  capability.kind === "media";

/** What is playing, as a tile names it: its title, or the app's name. */
export function whatsPlaying(state: MediaState): string | null {
  return state.media?.title ?? state.app?.name ?? null;
}

/**
 * What a media player's tile says: "Playing · Slow Horses", "Paused",
 * "On · Netflix" while an app is open with nothing playing, "Off" or "Not
 * playing"; "Not responding" when it missed the last command. Its detail,
 * which shows what plays, says only what it is doing (`what: false`).
 */
export function mediaText(
  capability: Media,
  options: { what?: boolean } = {},
): string {
  const { state } = capability;
  if (!state) return "Not playing";
  if (capability.sync === "conflict") return "Not responding";
  if (state.on === false) return "Off";
  const what = options.what === false ? null : whatsPlaying(state);
  const doing = {
    playing: "Playing",
    paused: "Paused",
    loading: "Loading",
    idle: null,
  }[state.activity];
  if (doing) return what ? `${doing} · ${what}` : doing;
  return state.app ? `On · ${state.app.name}` : "Not playing";
}

/**
 * Whether a player's round button can play or pause it now: it pauses what
 * plays and plays what is paused, where the player takes that, and does
 * nothing while it is off or has nothing to play.
 */
export function canPlayPause(capability: Media): boolean {
  const { state, features } = capability;
  if (!state || state.on === false) return false;
  if (state.activity === "playing") return features.playback.includes("pause");
  if (state.activity === "paused") return features.playback.includes("play");
  return false;
}

/** What playing or pausing a player's tile asks of it. */
export const playPauseCommand = (tile: Tile) =>
  ({ activity: tile.media?.playing ? "paused" : "playing" }) as const;

// The types a media player is shown as, in the order Media's summary lists
// them, each as its summary tile names them.
const summaryTypes: readonly { type: DeviceType; title: string }[] = [
  { type: "tv", title: "TVs" },
  { type: "speaker", title: "Speakers" },
  { type: "smart-speaker", title: "Smart Speakers" },
  { type: "media-player", title: "Media Players" },
];

/**
 * Media's summary: for each type the home's players are shown as, how many
 * are playing, or "Not playing" while none is.
 */
export function mediaSummary(
  tiles: readonly Tile[],
  devices: readonly DeviceInfo[],
): { type: DeviceType; title: string; status: string; spoken: string }[] {
  const typeOf = new Map(devices.map((device) => [device.id, device.type]));
  const players = tiles.filter((tile) => tile.kind === "media");
  return summaryTypes.flatMap(({ type, title }) => {
    const own = players.filter((tile) => typeOf.get(tile.deviceId) === type);
    if (own.length === 0) return [];
    const playing = own.filter((tile) => tile.media?.playing).length;
    const status = playing > 0 ? `${playing} playing` : "Not playing";
    return [{ type, title, status, spoken: status }];
  });
}

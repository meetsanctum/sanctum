import { deviceCategories, type DeviceInfo } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { sectionsOfRoom, tilesIn, tilesOf } from "../src/device-tiles";
import {
  canPlayPause,
  mediaSummary,
  mediaText,
  playPauseCommand,
  type Media,
} from "../src/media";
import { mediaPlayer, places } from "./place-pages-fixtures";

// What media players say: on a tile, in the detail's header and in Media's
// summary, and when a tile's round button can play or pause one.

const show = {
  title: "The Long Way Round",
  series: "The Long Way Round",
  season: 2,
  episode: 4,
};
const playerOf = (device: DeviceInfo) => device.capabilities[0] as Media;
const tiles = (devices: DeviceInfo[]) => tilesOf(devices, places, new Map());

describe("a media player's words", () => {
  it("say what it does and what plays, by its title or else its app", () => {
    const says = (state: Media["state"]) =>
      mediaText(playerOf(mediaPlayer("box", "Box", "office", state)));
    expect(says({ on: true, activity: "playing", media: show })).toBe(
      "Playing · The Long Way Round",
    );
    expect(
      says({
        on: true,
        activity: "paused",
        app: { id: "tv.example", name: "TV" },
        media: null,
      }),
    ).toBe("Paused · TV");
    expect(says({ on: true, activity: "loading" })).toBe("Loading");
  });

  it("say On with the app that is open while nothing plays, and Off or Not playing otherwise", () => {
    const says = (state: Media["state"]) =>
      mediaText(playerOf(mediaPlayer("box", "Box", "office", state)));
    expect(
      says({ on: true, activity: "idle", app: { id: "a", name: "Netflix" } }),
    ).toBe("On · Netflix");
    expect(says({ on: true, activity: "idle" })).toBe("Not playing");
    expect(says({ on: false, activity: "idle", media: show })).toBe("Off");
    expect(says(null)).toBe("Not playing");
    // A speaker says nothing of power.
    expect(says({ activity: "idle" })).toBe("Not playing");
  });

  it("say only what it does in its detail, which shows what plays", () => {
    const player = playerOf(
      mediaPlayer("box", "Box", "office", {
        on: true,
        activity: "playing",
        media: show,
      }),
    );
    expect(mediaText(player, { what: false })).toBe("Playing");
  });

  it("say Not responding when it missed the last command", () => {
    const device = mediaPlayer("box", "Box", "office", {
      on: true,
      activity: "playing",
    });
    expect(mediaText({ ...playerOf(device), sync: "conflict" } as Media)).toBe(
      "Not responding",
    );
  });
});

describe("a media player's tile", () => {
  it("is White while it plays, and its round button pauses it", () => {
    const [tile] = tiles([
      mediaPlayer("box", "Box", "office", {
        on: true,
        activity: "playing",
        media: show,
      }),
    ]);
    expect(tile).toMatchObject({
      kind: "media",
      status: "Playing · The Long Way Round",
      look: "on",
      on: true,
      media: { playing: true, canPlayPause: true },
    });
    expect(playPauseCommand(tile!)).toEqual({ activity: "paused" });
  });

  it("plays what is paused, and can do nothing while off, idle or offline", () => {
    const can = (state: Media["state"], features = {}) =>
      canPlayPause(
        playerOf(mediaPlayer("box", "Box", "office", state, features)),
      );
    expect(can({ on: true, activity: "paused", media: show })).toBe(true);
    expect(can({ on: true, activity: "idle" })).toBe(false);
    expect(can({ on: false, activity: "paused" })).toBe(false);
    expect(can(null)).toBe(false);
    // Not where the player can't pause.
    expect(
      can({ on: true, activity: "playing" }, { playback: ["play", "stop"] }),
    ).toBe(false);
    const [offline] = tiles([
      {
        ...mediaPlayer("box", "Box", "office", {
          on: true,
          activity: "playing",
        }),
        availability: "offline",
      },
    ]);
    expect(offline).toMatchObject({
      status: "Offline",
      disabled: true,
      media: { playing: false, canPlayPause: false },
    });
  });

  it("is under Media, on its room's page as on Media's", () => {
    const devices = [
      mediaPlayer("box", "Box", "office", { on: true, activity: "idle" }),
    ];
    const shown = tiles(devices);
    const media = deviceCategories.find((each) => each.id === "media")!;
    expect(tilesIn(media, shown).map((tile) => tile.name)).toEqual(["Box"]);
    expect(
      sectionsOfRoom(shown, devices).map((section) => section.title),
    ).toEqual(["Media"]);
  });
});

describe("Media's summary", () => {
  it("counts what plays by what each player is shown as, in Title Case", () => {
    const devices = [
      mediaPlayer(
        "box",
        "Box",
        "office",
        {
          on: true,
          activity: "playing",
        },
        {},
        "tv",
      ),
      mediaPlayer(
        "speaker",
        "Speaker",
        "hall",
        { activity: "idle" },
        {},
        "smart-speaker",
      ),
      mediaPlayer("other", "Other", "attic", { on: true, activity: "paused" }),
    ];
    expect(
      mediaSummary(tiles(devices), devices).map(({ title, status }) => [
        title,
        status,
      ]),
    ).toEqual([
      ["TVs", "1 playing"],
      ["Smart Speakers", "Not playing"],
      ["Media Players", "Not playing"],
    ]);
  });
});

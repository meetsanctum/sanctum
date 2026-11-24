// @vitest-environment jsdom
import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { mediaHistoryPage } from "../src/media-history";
import { mediaPlayer } from "./place-pages-fixtures";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

// A media player's History page: its day as a band of playing, with on
// without playing where it has power, and its week as time played a day,
// from core History.

const hour = 60 * 60_000;
// 22:40 where the tests run.
const now = new Date(2026, 10, 23, 22, 40).getTime();
const at = (hours: number, minutes = 0) =>
  new Date(2026, 10, 23, hours, minutes).toISOString();

let root: Root;
let container: HTMLDivElement;
let kept: boolean;
let states: { at: string; availability: string; state: object | null }[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  kept = true;
  states = [];
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    const query = new URL(path, "http://core").searchParams;
    const common = {
      device: query.get("device"),
      capability: "player",
      kind: "media",
      from: query.get("from"),
      to: query.get("to"),
      kept,
    };
    if (path.startsWith("/api/history/states")) {
      return { ...common, states: kept ? states : [] };
    }
    if (path.startsWith("/api/history/statistics")) {
      // Yesterday, playing for half of one hour.
      return {
        ...common,
        period: "hour",
        fields: {
          playing: [
            {
              start: new Date(2026, 10, 22, 20).toISOString(),
              mean: 0.5,
              min: 0,
              max: 1,
              seconds: 3600,
            },
          ],
        },
      };
    }
    throw new Error(`Unexpected ${path}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function show(device: DeviceInfo) {
  const player = device.capabilities[0]!;
  if (player.kind !== "media") throw new Error("not a media player");
  await act(async () => {
    root.render(mediaHistoryPage(device, player).content);
  });
  // The history arrives.
  await act(async () => {});
}

const spoken = () =>
  [...container.querySelectorAll("ul.sr-only li")].map(
    (each) => each.textContent,
  );

it("shows a TV's day as playing, on and off, and its week as time played", async () => {
  states = [
    {
      at: at(-2),
      availability: "online",
      state: { on: false, activity: "idle" },
    },
    {
      at: at(19, 30),
      availability: "online",
      state: { on: true, activity: "idle" },
    },
    {
      at: at(19, 45),
      availability: "online",
      state: { on: true, activity: "playing" },
    },
  ];
  await show(
    mediaPlayer("tv", "TV", "living", { on: true, activity: "playing" }),
  );

  const text = container.textContent ?? "";
  expect(text).toContain("Last 24 hours");
  expect(text).toContain("Played 2 h 55 min");
  expect(text).toContain("On for 3 h 10 min");
  expect(
    container.querySelector(
      '[role="group"][aria-label="Playing over the last 24 hours"]',
    ),
  ).not.toBeNull();
  expect(spoken()).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/ to 19:30: Off$/),
      "19:30 to 19:45: On",
      "19:45 to 22:40: Playing",
    ]),
  );
  expect(text).toContain("Last 7 days");
  // Yesterday's half hour, over the one day that has ended.
  expect(text).toContain("Played about 30 min a day");
  expect(
    container.querySelector(
      '[role="group"][aria-label="How long it played each day"]',
    ),
  ).not.toBeNull();
  expect(spoken()).toContainEqual(
    expect.stringMatching(/: played for 30 min$/),
  );
});

it("says when a speaker last played, without on or off", async () => {
  states = [
    { at: at(-2), availability: "online", state: { activity: "idle" } },
    { at: at(17, 10), availability: "online", state: { activity: "playing" } },
    { at: at(18), availability: "online", state: { activity: "paused" } },
  ];
  await show(
    mediaPlayer(
      "speaker",
      "Speaker",
      "office",
      { activity: "paused" },
      { power: false, volume: "level" },
      "smart-speaker",
    ),
  );

  const text = container.textContent ?? "";
  expect(text).toContain("Played 50 min");
  expect(text).toContain("Last played 17:10–18:00");
  expect(text).not.toContain("On for");
  expect(spoken()).toEqual(
    expect.arrayContaining([
      "17:10 to 18:00: Playing",
      "18:00 to 22:40: Not playing",
    ]),
  );
});

it("says so where the household does not keep its history", async () => {
  kept = false;
  await show(
    mediaPlayer("tv", "TV", "living", { on: true, activity: "playing" }),
  );
  expect(container.textContent).toContain("doesn't keep this device's history");
  expect(container.textContent).not.toContain("Last 24 hours");
});

it("reads its history as the player's, from the day before", async () => {
  await show(
    mediaPlayer("tv", "TV", "living", { on: true, activity: "playing" }),
  );
  const asked = vi
    .mocked(coreJson)
    .mock.calls.map(([path]) => path)
    .find((path) => path.startsWith("/api/history/states"))!;
  const query = new URL(asked, "http://core").searchParams;
  expect(query.get("device")).toBe("tv");
  expect(query.get("capability")).toBe("player");
  expect(query.get("from")).toBe(new Date(now - 24 * hour).toISOString());
});

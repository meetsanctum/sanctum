// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { chooseDrawing, followEffects } from "../src/effects";

// Reduce effects and Reduce motion, each on or off on its own as set for
// this client, and off until set: what a device is and what its system asks
// for turn neither on. `?effects=` and `?motion=` decide them instead.

const shelly =
  "Mozilla/5.0 (Linux; Android 11; Blake Build/RD2A.211001.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/157.0.8103.38 Safari/537.36 ShellyStargate/2.8.5-b566114e7";

const html = document.documentElement;
const said = () => ({
  effects: html.dataset.effects ?? "regular",
  motion: html.dataset.motion ?? "regular",
});

// A window on a slow device whose system asks for reduced transparency and
// reduced motion, which the shell doesn't follow.
function windowAt(search = "") {
  const asks = Object.assign(new EventTarget(), { matches: true });
  return {
    matchMedia: () => asks,
    navigator: { userAgent: shelly },
    location: { search },
    document,
  } as unknown as Window;
}

describe("what the page says", () => {
  let stop = () => {};
  afterEach(() => {
    stop();
    delete html.dataset.effects;
    delete html.dataset.motion;
  });

  it("draws everything regular until either is turned on, whatever the device", () => {
    stop = followEffects(windowAt());
    expect(said()).toEqual({ effects: "regular", motion: "regular" });
  });

  it("turns each on and off on its own", () => {
    stop = followEffects(windowAt());

    chooseDrawing({ reduceEffects: true, reduceMotion: false });
    expect(said()).toEqual({ effects: "reduced", motion: "regular" });
    chooseDrawing({ reduceEffects: true, reduceMotion: true });
    expect(said()).toEqual({ effects: "reduced", motion: "reduced" });
    chooseDrawing({ reduceEffects: false, reduceMotion: true });
    expect(said()).toEqual({ effects: "regular", motion: "reduced" });
    chooseDrawing({ reduceEffects: false, reduceMotion: false });
    expect(said()).toEqual({ effects: "regular", motion: "regular" });
  });

  it("goes back to off once it stops following", () => {
    stop = followEffects(windowAt());
    chooseDrawing({ reduceEffects: true, reduceMotion: true });
    stop();
    stop = followEffects(windowAt());
    expect(said()).toEqual({ effects: "regular", motion: "regular" });
  });

  it.each([
    ["?effects=reduced&motion=reduced", false, "reduced", "reduced"],
    ["?effects=regular&motion=regular", true, "regular", "regular"],
    ["?effects=reduced", false, "reduced", "regular"],
    ["?motion=sideways", true, "reduced", "reduced"],
  ] as const)(
    "lets %s in the address decide",
    (search, on, effects, motion) => {
      stop = followEffects(windowAt(search));
      chooseDrawing({ reduceEffects: on, reduceMotion: on });
      expect(said()).toEqual({ effects, motion });
    },
  );
});

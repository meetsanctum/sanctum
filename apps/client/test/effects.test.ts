// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { Drawn } from "@meetsanctum/auth-protocol";

import {
  chooseDrawing,
  effectsOf,
  followDrawn,
  followEffects,
  motionOf,
} from "../src/effects";

// How a device draws effects and motion: plainly on a Shelly wall display,
// where the system asks for reduced transparency or reduced motion, or as
// the address says.

const browser =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
const shelly =
  "Mozilla/5.0 (Linux; Android 11; Blake Build/RD2A.211001.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/157.0.8103.38 Safari/537.36 ShellyStargate/2.8.5-b566114e7;SAWD-3A1XE10EU2";

describe("how a device draws effects", () => {
  it.each([
    ["a browser", browser, false, "", "regular"],
    ["a Shelly wall display", shelly, false, "", "reduced"],
    ["a browser asked for reduced transparency", browser, true, "", "reduced"],
    [
      "any device the address asks for",
      browser,
      false,
      "?effects=reduced",
      "reduced",
    ],
    [
      "a Shelly the address asks for",
      shelly,
      true,
      "?effects=regular",
      "regular",
    ],
    [
      "an address that asks for neither",
      shelly,
      false,
      "?effects=plain",
      "reduced",
    ],
  ] as const)("%s", (_, userAgent, reducedTransparency, search, effects) => {
    expect(effectsOf({ userAgent, reducedTransparency, search })).toBe(effects);
  });
});

describe("how a device draws motion", () => {
  it.each([
    ["a browser", browser, false, "", "regular"],
    ["a Shelly wall display", shelly, false, "", "reduced"],
    ["a browser asked for reduced motion", browser, true, "", "reduced"],
    [
      "any device the address asks for",
      browser,
      false,
      "?motion=reduced",
      "reduced",
    ],
    [
      "a Shelly the address asks for",
      shelly,
      true,
      "?motion=regular",
      "regular",
    ],
    [
      "an address that asks for effects only",
      shelly,
      false,
      "?effects=regular",
      "reduced",
    ],
  ] as const)("%s", (_, userAgent, reducedMotion, search, motion) => {
    expect(motionOf({ userAgent, reducedMotion, search })).toBe(motion);
  });
});

describe("what the page says", () => {
  afterEach(() => {
    delete document.documentElement.dataset.effects;
    delete document.documentElement.dataset.motion;
  });

  // A window whose system turns reduced transparency and reduced motion on
  // and off.
  function windowWith(userAgent: string, search = "") {
    const transparency = Object.assign(new EventTarget(), { matches: false });
    const motion = Object.assign(new EventTarget(), { matches: false });
    const win = {
      matchMedia: (media: string) => {
        if (media === "(prefers-reduced-motion: reduce)") return motion;
        expect(media).toBe("(prefers-reduced-transparency: reduce)");
        return transparency;
      },
      navigator: { userAgent },
      location: { search },
      document,
    } as unknown as Window;
    const set = (query: typeof motion) => (matches: boolean) => {
      query.matches = matches;
      query.dispatchEvent(new Event("change"));
    };
    return { win, setReduced: set(transparency), setMotion: set(motion) };
  }

  it("says reduced on <html> on a Shelly, before anything is drawn", () => {
    followEffects(windowWith(shelly).win);
    expect(document.documentElement.dataset.effects).toBe("reduced");
    expect(document.documentElement.dataset.motion).toBe("reduced");
  });

  it("follows the system's reduced motion as it changes, apart from effects", () => {
    const { win, setMotion } = windowWith(browser);
    const stop = followEffects(win);
    expect(document.documentElement.hasAttribute("data-motion")).toBe(false);

    setMotion(true);
    expect(document.documentElement.dataset.motion).toBe("reduced");
    expect(document.documentElement.hasAttribute("data-effects")).toBe(false);
    setMotion(false);
    expect(document.documentElement.hasAttribute("data-motion")).toBe(false);

    stop();
    setMotion(true);
    expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
  });

  it("follows the system's reduced transparency as it changes", () => {
    const { win, setReduced } = windowWith(browser);
    const stop = followEffects(win);
    expect(document.documentElement.hasAttribute("data-effects")).toBe(false);

    setReduced(true);
    expect(document.documentElement.dataset.effects).toBe("reduced");
    setReduced(false);
    expect(document.documentElement.hasAttribute("data-effects")).toBe(false);

    stop();
    setReduced(true);
    expect(document.documentElement.hasAttribute("data-effects")).toBe(false);
  });
});

describe("its choices", () => {
  afterEach(() => {
    delete document.documentElement.dataset.effects;
    delete document.documentElement.dataset.motion;
  });

  it.each([
    ["On", browser, "on", "reduced"],
    ["Off", shelly, "off", "regular"],
    ["Automatic", shelly, "automatic", "reduced"],
  ] as const)("draws %s as chosen", (_, userAgent, choice, drawn) => {
    const device = { userAgent, search: "" };
    expect(effectsOf({ ...device, reducedTransparency: false }, choice)).toBe(
      drawn,
    );
    expect(motionOf({ ...device, reducedMotion: false }, choice)).toBe(drawn);
  });

  it("leaves the address the last word while developing", () => {
    const device = { userAgent: browser, search: "?effects=regular" };
    expect(effectsOf({ ...device, reducedTransparency: true }, "on")).toBe(
      "regular",
    );
  });

  it("follows each new choice on <html> and says what it draws with", () => {
    const win = {
      matchMedia: () => Object.assign(new EventTarget(), { matches: false }),
      navigator: { userAgent: shelly },
      location: { search: "" },
      document,
    } as unknown as Window;
    const stop = followEffects(win);
    const said: Drawn[] = [];
    const stopHearing = followDrawn((drawn) => said.push(drawn));
    expect(said).toEqual([
      { effects: "reduced", motion: "reduced", slowDevice: true },
    ]);

    chooseDrawing({ effects: "automatic", motion: "off" });
    expect(document.documentElement.dataset.effects).toBe("reduced");
    expect(document.documentElement.hasAttribute("data-motion")).toBe(false);
    // The same choices again say nothing new.
    chooseDrawing({ effects: "automatic", motion: "off" });
    expect(said).toEqual([
      { effects: "reduced", motion: "reduced", slowDevice: true },
      { effects: "reduced", motion: "regular", slowDevice: true },
    ]);

    stopHearing();
    stop();
  });
});

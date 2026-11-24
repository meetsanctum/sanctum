// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { effectsOf, followEffects } from "../src/effects";

// How a device draws effects: plainly on a Shelly wall display and where
// the system asks for reduced transparency, or as the address says.

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

describe("what the page says", () => {
  afterEach(() => {
    delete document.documentElement.dataset.effects;
  });

  // A window whose system turns reduced transparency on and off.
  function windowWith(userAgent: string, search = "") {
    const query = Object.assign(new EventTarget(), { matches: false });
    const win = {
      matchMedia: (media: string) => {
        expect(media).toBe("(prefers-reduced-transparency: reduce)");
        return query;
      },
      navigator: { userAgent },
      location: { search },
      document,
    } as unknown as Window;
    const setReduced = (matches: boolean) => {
      query.matches = matches;
      query.dispatchEvent(new Event("change"));
    };
    return { win, setReduced };
  }

  it("says reduced on <html> on a Shelly, before anything is drawn", () => {
    followEffects(windowWith(shelly).win);
    expect(document.documentElement.dataset.effects).toBe("reduced");
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

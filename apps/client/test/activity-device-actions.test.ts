import { describe, expect, it } from "vitest";

import { activityWords, lastChangeWords } from "../src/activity/words";
import { entry } from "./activity-fixtures";

// An app's action about one of its devices, as a smart speaker's page
// changes its microphones or ring: said of the device in the home's list,
// of "it" in the device's own, and how many times where changes joined.

const esphome = { id: "sanctum.esphome", name: "ESPHome" };
const speaker = {
  type: "device" as const,
  id: "speaker",
  name: "Office Speaker",
  gone: false,
};

const ringChange = (fields: Parameters<typeof entry>[0] = {}) =>
  entry({
    kind: "setup",
    source: "sanctum.esphome",
    action: "esphome.changeRing",
    title: "Change its ring",
    done: "Changed its ring",
    detail: null,
    app: esphome,
    subject: speaker,
    ...fields,
  });

describe("an app's action about a device", () => {
  it("says what it did to the device", () => {
    expect(activityWords(ringChange())).toEqual({
      title: "Office Speaker changed its ring",
      detail: "Alex, with ESPHome",
      problem: false,
    });
    expect(activityWords(ringChange(), "device").title).toBe(
      "Changed its ring",
    );
  });

  it("says how many times, and over when, where changes joined", () => {
    const words = activityWords(
      ringChange({
        count: 4,
        firstAt: "2026-10-31T21:50:00",
        at: "2026-10-31T21:52:00",
      }),
    );
    expect(words.title).toBe("Office Speaker changed its ring, 4 times");
    expect(words.detail).toBe("Alex, with ESPHome · 21:50–21:52");
  });

  it("says when it didn't work, by the action's title", () => {
    expect(activityWords(ringChange({ outcome: "failed" }))).toEqual({
      title: "Office Speaker: Change its ring didn't work",
      detail: "Alex, with ESPHome",
      problem: true,
    });
  });

  it("reads by its title when it isn't about a device", () => {
    expect(activityWords(ringChange({ subject: null })).title).toBe(
      "Change its ring",
    );
  });

  it("uses the app's words for the device's last change", () => {
    expect(lastChangeWords(ringChange({ at: "2026-10-31T21:52:00" }))).toBe(
      "Alex changed its ring at 21:52",
    );
  });

  it("uses the app's words when its action id matches a press", () => {
    const log = ringChange({
      action: "device.press",
      at: "2026-10-31T21:52:00",
    });
    expect(lastChangeWords(log)).toBe("Alex changed its ring at 21:52");
  });
});

describe("a smart speaker's microphones", () => {
  const microphones = (
    muted: boolean,
    fields: Parameters<typeof entry>[0] = {},
  ) =>
    entry({
      detail: {
        capability: "audio",
        capabilityKind: "audio",
        asked: { muted },
      },
      subject: speaker,
      ...fields,
    });

  it("say they were muted or turned on", () => {
    expect(activityWords(microphones(true)).title).toBe(
      "Office Speaker muted its microphones",
    );
    expect(activityWords(microphones(false), "device").title).toBe(
      "Turned on its microphones",
    );
  });

  it("say what didn't happen when its own switch held them", () => {
    expect(
      activityWords(
        microphones(false, { outcome: "failed", reason: "no_answer" }),
        "device",
      ).title,
    ).toBe("Didn't turn on its microphones: it didn't answer");
  });
});

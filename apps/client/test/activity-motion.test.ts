import type { ActivityInfo } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { activityWords } from "../src/activity/words";
import { entry } from "./activity-fixtures";

// How the activity log reads a motion sensor's settings and the runs its
// motion starts.

const sensor = {
  type: "device" as const,
  id: "motion",
  name: "Office motion sensor",
  gone: false,
};
const setting = (
  asked: Record<string, unknown>,
  fields: Partial<ActivityInfo> = {},
) =>
  entry({
    subject: sensor,
    detail: { capability: "occupancy", asked },
    ...fields,
  });

describe("a motion sensor's settings in the activity log", () => {
  it.each([
    [
      { sensitivity: "high" },
      "Office motion sensor's sensitivity set to High",
      "Sensitivity set to High",
    ],
    [
      { sensitivity: "max" },
      "Office motion sensor's sensitivity set to Highest",
      "Sensitivity set to Highest",
    ],
    [
      { clearAfter: 120 },
      "Office motion sensor says no motion after 2 minutes",
      "Says no motion after 2 minutes",
    ],
    [
      { clearAfter: 90 },
      "Office motion sensor says no motion after 90 seconds",
      "Says no motion after 90 seconds",
    ],
    [
      { indicator: true },
      "Office motion sensor blinks on motion",
      "Blinks on motion",
    ],
    [
      { indicator: false },
      "Office motion sensor no longer blinks on motion",
      "No longer blinks on motion",
    ],
  ])("says what changed (%j)", (asked, home, device) => {
    expect(activityWords(setting(asked), "home")).toEqual({
      title: home,
      detail: "Alex",
      problem: false,
    });
    expect(activityWords(setting(asked), "device").title).toBe(device);
  });

  it("says a change it didn't take as other commands do", () => {
    expect(
      activityWords(
        setting(
          { sensitivity: "high" },
          { outcome: "failed", reason: "no_answer" },
        ),
        "home",
      ),
    ).toEqual({
      title:
        "Office motion sensor didn't set its sensitivity to High: it didn't answer",
      detail: "Alex",
      problem: true,
    });
    expect(
      activityWords(
        setting(
          { indicator: true },
          { outcome: "refused", reason: "invalid_request" },
        ),
        "device",
      ).title,
    ).toBe("Couldn't start blinking on motion");
    expect(
      activityWords(
        setting(
          { clearAfter: 60 },
          { outcome: "failed", reason: "app_failed" },
        ),
        "device",
      ).title,
    ).toBe("Didn't change when it says no motion");
  });
});

describe("a run that motion starts, in the activity log", () => {
  const run = (trigger: Record<string, unknown>, name: string) => ({
    entry: "run",
    workflow: "w",
    name,
    app: "sanctum.moods",
    trigger: { piece: "motion", app: null, ...trigger },
  });
  const by = (trigger: Record<string, unknown>, name: string) =>
    entry({
      who: { kind: "workflow", id: "w", name },
      run: run(trigger, name),
    });

  it("names the motion that started it, in the place it was", () => {
    expect(
      activityWords(
        by({ place: "Office" }, "Office lights on with motion"),
        "home",
      ).detail,
    ).toBe("Office lights on with motion, motion in Office");
    expect(
      activityWords(
        by(
          { piece: "noMotion", place: "Office", forMinutes: 10 },
          "Office lights off with no motion",
        ),
        "home",
      ).detail,
    ).toBe("Office lights off with no motion, no motion in Office for 10 min");
    expect(
      activityWords(
        entry({
          action: "workflow.run",
          who: { kind: "workflow", id: "w", name: "Office lights on" },
          run: run({ place: "Office" }, "Office lights on"),
          detail: { status: "succeeded" },
        }),
        "home",
      ),
    ).toEqual({
      title: "Ran Office lights on",
      detail: "Motion in Office",
      problem: false,
    });
  });

  it("still reads when the run doesn't say where", () => {
    expect(activityWords(by({}, "Hall lights"), "home").detail).toBe(
      "Hall lights, after motion",
    );
    expect(
      activityWords(by({ piece: "noMotion" }, "Hall lights off"), "home")
        .detail,
    ).toBe("Hall lights off, after no motion");
  });
});

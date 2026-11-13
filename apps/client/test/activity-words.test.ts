import type { ActivityInfo } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { activityWords, lastChangeWords } from "../src/activity/words";
import { entry } from "./activity-fixtures";

// How each entry of the activity log reads in the client, in a device's list
// and the home's.

const press = {
  kind: "press" as const,
  device: "remote",
  name: "Office button",
  action: "single",
};
const moods = { id: "sanctum.moods", name: "Moods" };

describe("an entry's words", () => {
  it.each([
    [{ on: true, brightness: 40 }, "Turned on at 40%"],
    [{ on: true }, "Turned on"],
    [{ on: false }, "Turned off"],
    [{ brightness: 40, colorTemperature: 370 }, "Set to 40%, warm white"],
    [{ colorTemperature: 160 }, "Set to cool white"],
    [{ hue: 20, saturation: 80 }, "Set to a colour"],
  ])("says what a command asked for (%j)", (asked, title) => {
    const words = activityWords(
      entry({ detail: { capability: "light", asked } }),
      "device",
    );
    expect(words).toEqual({ title, detail: "Alex", problem: false });
  });

  it("says which way a remote's hold moved a light, and a stop that failed", () => {
    expect(
      activityWords(
        entry({ detail: { capability: "light", move: "down" } }),
        "device",
      ).title,
    ).toBe("Dimmed while held");
    expect(
      activityWords(
        entry({ detail: { capability: "light", move: "up" } }),
        "home",
      ).title,
    ).toBe("Lamp brightened while held");
    expect(
      activityWords(
        entry({
          outcome: "failed",
          reason: "app_failed",
          detail: { capability: "light", move: "stop" },
        }),
        "device",
      ),
    ).toMatchObject({ title: "Didn't stop", problem: true });
  });

  it("says a device on a battery went quiet, its battery fell low and it had a new one", () => {
    const device = { kind: "device" as const };
    expect(
      activityWords(
        entry({ action: "device.quiet", who: device, detail: { battery: 6 } }),
        "home",
      ),
    ).toEqual({
      title: "Lamp went quiet",
      detail: "Not heard from, last at 6%",
      problem: false,
    });
    expect(
      activityWords(
        entry({ action: "device.quiet", who: device, detail: null }),
        "device",
      ).detail,
    ).toBe("Not heard from");
    expect(
      activityWords(
        entry({
          action: "device.battery.low",
          who: device,
          detail: { battery: 9, was: 40 },
        }),
        "home",
      ),
    ).toEqual({
      title: "Lamp has a low battery",
      detail: "9%: replace it soon",
      problem: false,
    });
    expect(
      activityWords(
        entry({
          action: "device.battery.new",
          who: device,
          detail: { battery: 100, was: 8 },
        }),
        "device",
      ),
    ).toEqual({
      title: "Has a new battery",
      detail: "100%, up from 8%",
      problem: false,
    });
  });

  it("starts with the device's name in the home's list", () => {
    expect(activityWords(entry(), "home").title).toBe("Lamp turned on at 80%");
  });

  it("names the press, the automation and the app behind a command", () => {
    const run = {
      entry: "run",
      workflow: "focus",
      name: "Desk focus",
      app: null,
      trigger: { piece: "press", app: null },
    };
    expect(
      activityWords(entry({ who: press, app: moods }), "device").detail,
    ).toBe("Office button, single press, with Moods");
    expect(activityWords(entry({ who: press, run }), "device").detail).toBe(
      "Office button, single press, through Desk focus",
    );
    const sunset = {
      ...run,
      name: "Evening",
      trigger: {
        piece: "sun",
        app: null,
        event: "sunset" as const,
        offsetMinutes: -20,
      },
    };
    expect(
      activityWords(
        entry({
          who: { kind: "workflow", id: "evening", name: "Evening" },
          run: sunset,
        }),
        "device",
      ).detail,
    ).toBe("Evening, 20 min before sunset");
    expect(
      activityWords(
        entry({
          who: { kind: "client", id: "tablet", name: "Hallway tablet" },
        }),
        "device",
      ).detail,
    ).toBe("Hallway tablet");
    expect(
      activityWords(entry({ who: { kind: "device" } }), "device").detail,
    ).toBe("Outside Sanctum, at the device or its switch");
  });

  it("joins a morning of adjustments into one", () => {
    const words = activityWords(
      entry({
        count: 12,
        at: "2026-10-31T08:10:00",
        firstAt: "2026-10-31T07:05:00",
        who: {
          kind: "app",
          id: "sanctum.natural-light",
          name: "Natural light",
        },
        app: { id: "sanctum.natural-light", name: "Natural light" },
        detail: { asked: { brightness: 55 }, from: { brightness: 30 } },
      }),
      "device",
    );
    expect(words).toEqual({
      title: "Adjusted 12 times, 30% to 55%",
      detail: "Natural light · 07:05–08:10",
      problem: false,
    });
  });

  it("says when a device didn't answer, as a problem", () => {
    expect(
      activityWords(
        entry({
          outcome: "failed",
          reason: "no_answer",
          detail: { asked: { on: false } },
        }),
        "device",
      ),
    ).toEqual({
      title: "Didn't turn off: it didn't answer",
      detail: "Alex",
      problem: true,
    });
  });

  it.each([
    ["ok", "Turned off", false],
    ["failed", "Didn't turn off: it didn't answer", true],
  ] as const)("says a command went again (%s)", (outcome, title, problem) => {
    const detail = { asked: { on: false }, resent: true };
    const reason = outcome === "failed" ? "no_answer" : null;
    expect(activityWords(entry({ outcome, reason, detail }), "device")).toEqual(
      { title, detail: "Alex · Sent again", problem },
    );
  });

  it("says a device left its network, naming the network by its app", () => {
    const left = entry({
      kind: "setup",
      action: "device.left",
      detail: null,
      who: { kind: "device" },
      app: { id: "sanctum.zigbee", name: "Zigbee" },
      subject: { type: "device", id: "plug", name: "Hall plug", gone: false },
    });
    expect(activityWords(left, "home")).toEqual({
      title: "Hall plug left the Zigbee network",
      detail: "Its network no longer has it, as after a reset",
      problem: false,
    });
    expect(activityWords({ ...left, app: null }, "device").title).toBe(
      "Left its network",
    );
  });

  it("says what its driver found wrong with a device, in the driver's words", () => {
    const found = entry({
      kind: "devices",
      action: "device.problem",
      detail: {
        name: "Hall plug",
        problem: "Its encryption key doesn't match",
      },
      who: { kind: "device" },
      app: { id: "sanctum.example", name: "Example" },
      subject: { type: "device", id: "plug", name: "Hall plug", gone: false },
    });
    expect(activityWords(found, "home")).toEqual({
      title: "Hall plug has a problem",
      detail: "Its encryption key doesn't match",
      problem: true,
    });
  });

  it.each([
    ["ok", "Repaired", false],
    ["refused", "Couldn't be repaired", true],
  ] as const)("says a device was repaired (%s)", (outcome, title, problem) => {
    const repaired = entry({
      kind: "devices",
      action: "device.repair",
      outcome,
      detail: { name: "Hall plug" },
    });
    expect(activityWords(repaired, "device")).toMatchObject({
      title,
      problem,
    });
  });

  it("says what a press did", () => {
    const pressed = (fields: Partial<ActivityInfo>) =>
      activityWords(
        entry({
          action: "device.press",
          who: press,
          detail: { capability: "button", action: "double", captured: false },
          ...fields,
        }),
        "device",
      );
    const nothing = { runs: [], apps: [], devices: [], failed: 0 };
    expect(pressed({ caused: nothing })).toMatchObject({
      title: "Double press",
      detail: "Nothing is set for it",
    });
    expect(
      pressed({
        caused: {
          ...nothing,
          apps: [moods],
          devices: [{ type: "device", id: "lamp", name: "Lamp", gone: false }],
        },
      }).detail,
    ).toBe("Moods changed Lamp");
    expect(
      pressed({
        caused: {
          ...nothing,
          runs: [
            { type: "workflow", id: "focus", name: "Desk focus", gone: false },
          ],
        },
      }).detail,
    ).toBe("Ran Desk focus");
    expect(
      pressed({
        caused: nothing,
        detail: { capability: "button", action: "single", captured: true },
      }).detail,
    ).toBe("Heard while choosing a press, so it did nothing");
  });

  it("says how the system's things went, in the household's words", () => {
    const system = (fields: Partial<ActivityInfo>) =>
      activityWords(
        entry({
          kind: "system",
          source: "manager",
          who: { kind: "sanctum" },
          ...fields,
        }),
      );
    expect(
      system({
        action: "update.end",
        outcome: "failed",
        detail: { version: "0.4.3", from: "0.4.2", outcome: "rolled-back" },
      }),
    ).toMatchObject({
      title: "The update to 0.4.3 didn't work",
      detail: expect.stringContaining("went back to 0.4.2"),
      problem: true,
    });
    expect(
      system({
        action: "service.wait",
        outcome: "failed",
        detail: {
          service: "zigbee2mqtt",
          problem: "No Zigbee coordinator is plugged in",
        },
      }),
    ).toMatchObject({
      title: "Zigbee couldn't start",
      detail:
        "No Zigbee adapter is plugged in. Plug it in, and Zigbee starts by itself.",
    });
    expect(
      system({
        action: "service.wait",
        outcome: "failed",
        detail: {
          service: "zigbee2mqtt",
          problem: "Choose the adapter type of the Zigbee coordinator /dev/x",
        },
      }),
    ).toMatchObject({
      title: "Zigbee couldn't start",
      detail:
        "Sanctum doesn't recognise this Zigbee adapter's type by itself. The install guide says how to choose it, under “Zigbee does not start”.",
    });
    expect(
      system({
        source: "sanctum",
        action: "sanctum.start",
        at: "2026-10-31T03:20:00",
        detail: {
          version: "1.0.0",
          stoppedAt: "2026-10-31T01:10:00",
          unexpected: false,
        },
      }).detail,
    ).toBe("It was off from 01:10, for 2 h 10 min");
  });

  it("words restarting an app, and a restart that was refused", () => {
    expect(
      activityWords(
        entry({
          source: "sanctum.moods",
          action: "restart",
          app: moods,
          subject: null,
        }),
      ),
    ).toMatchObject({ title: "Restarted the app", problem: false });
    expect(
      activityWords(
        entry({
          source: "sanctum.moods",
          action: "restart",
          outcome: "refused",
          reason: "conflict",
          app: moods,
          subject: null,
        }),
      ),
    ).toMatchObject({ title: "Couldn't restart the app", problem: true });
  });

  it("words settings changes and refused updates without claiming success", () => {
    expect(
      activityWords(
        entry({
          source: "sanctum.moods",
          action: "settings.update",
          app: moods,
          subject: null,
        }),
      ),
    ).toEqual({
      title: "Changed app settings",
      detail: "Alex, with Moods",
      problem: false,
    });
    expect(
      activityWords(
        entry({
          source: "system",
          action: "update.start",
          outcome: "refused",
          reason: "busy",
        }),
      ),
    ).toMatchObject({ title: "Update couldn't start", problem: true });
  });

  it("says a run the core stopped during didn't finish", () => {
    expect(
      activityWords(
        entry({
          kind: "automations",
          source: "workflows",
          action: "workflow.run",
          outcome: "failed",
          reason: "interrupted",
          detail: { status: "failed" },
          who: { kind: "workflow", id: "evening", name: "Evening" },
          subject: {
            type: "workflow",
            id: "evening",
            name: "Evening",
            gone: false,
          },
        }),
      ),
    ).toEqual({
      title: "Evening didn't finish",
      detail: "Sanctum stopped while it ran",
      problem: true,
    });
  });

  it("says what was put on Home, taken off and rearranged, by Home's name then", () => {
    const home = (action: string, detail: ActivityInfo["detail"]) =>
      entry({ kind: "setup", source: "dashboards", action, detail });

    expect(
      activityWords(home("device.home.add", { dashboard: "Home" }), "device")
        .title,
    ).toBe("Added to Home");
    expect(
      activityWords(home("device.home.remove", { dashboard: "Overview" }))
        .title,
    ).toBe("Lamp removed from Overview");
    expect(
      activityWords({
        ...home("dashboard.order", null),
        subject: { type: "dashboard", id: "home", name: "Home", gone: false },
      }),
    ).toEqual({ title: "Rearranged Home", detail: "Alex", problem: false });
  });

  it("reads an app's action by its title", () => {
    expect(
      activityWords(
        entry({
          kind: "setup",
          source: "sanctum.moods",
          action: "moods.runMood",
          title: "Run mood",
          detail: null,
          app: moods,
          subject: null,
        }),
      ),
    ).toEqual({
      title: "Run mood",
      detail: "Alex, with Moods",
      problem: false,
    });
  });

  it("says the last change as a sentence", () => {
    expect(lastChangeWords(entry({ at: "2026-10-31T21:52:00" }))).toBe(
      "Alex turned it on at 21:52",
    );
  });
});

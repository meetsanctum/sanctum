import { homeClock } from "@meetsanctum/app-sdk/clock";
import type { ActivityInfo } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { triggerWords } from "../src/activity/actor-words";
import { activityWords, lastChangeWords } from "../src/activity/words";
import { productName } from "../src/brand";
import { entry } from "./activity-fixtures";

// The device's own zone, which the expectations here are worked out in.
const clock = homeClock();

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
      clock,
      entry({ detail: { capability: "light", asked } }),
      "device",
    );
    expect(words).toEqual({ title, detail: "Alex", problem: false });
  });

  it("says which way a remote's hold moved a light, and a stop that failed", () => {
    expect(
      activityWords(
        clock,
        entry({ detail: { capability: "light", move: "down" } }),
        "device",
      ).title,
    ).toBe("Dimmed while held");
    expect(
      activityWords(
        clock,
        entry({ detail: { capability: "light", move: "up" } }),
        "home",
      ).title,
    ).toBe("Lamp brightened while held");
    expect(
      activityWords(
        clock,
        entry({
          outcome: "failed",
          reason: "app_failed",
          detail: { capability: "light", move: "stop" },
        }),
        "device",
      ),
    ).toMatchObject({ title: "Didn't stop", problem: true });
  });

  it.each([
    [
      "channel_mismatch",
      `A shared device wasn't connected to ${productName} directly`,
    ],
    ["unchecked", "Couldn't check a shared device"],
    ["too_many_attempts", "Couldn't check a shared device"],
  ])("says the home couldn't check a shared device (%s)", (reason, title) => {
    expect(
      activityWords(
        clock,
        entry({
          kind: "system",
          source: "auth",
          action: "pair.check",
          outcome: "refused",
          reason,
          detail: null,
          subject: null,
        }),
        "home",
      ),
    ).toMatchObject({ title, problem: true });
  });

  it.each([
    ["invite.create", "ok", null, "Invited Jonas to sign in", false],
    [
      "invite.create",
      "ok",
      "reset",
      "Made Jonas a code for a new password",
      false,
    ],
    ["invite.cancel", "ok", null, "Cancelled Jonas's invite", false],
    ["invite.redeem", "ok", null, "Joined with an invite code", false],
    ["invite.redeem", "ok", "reset", "Chose a new password with a code", false],
    [
      "invite.redeem",
      "refused",
      "too_many_attempts",
      "Jonas's invite code was tried too often",
      true,
    ],
    [
      "invite.redeem",
      "refused",
      "channel_mismatch",
      `A device using an invite code wasn't connected to ${productName} directly`,
      true,
    ],
  ] as const)(
    "says what an invite did (%s, %s, %s)",
    (action, outcome, reason, title, problem) => {
      expect(
        activityWords(
          clock,
          entry({
            kind: "system",
            source: "auth",
            action,
            outcome,
            reason,
            detail: null,
            subject: {
              type: "person",
              id: "jonas",
              name: "Jonas",
              gone: false,
            },
          }),
          "home",
        ),
      ).toMatchObject({ title, problem });
    },
  );

  it("says what the household shows a device as, by what it then is", () => {
    const device = { kind: "device" as const };
    const shown = (detail: Record<string, unknown>) =>
      activityWords(
        clock,
        entry({ action: "device.update", who: device, detail }),
        "device",
      ).title;
    expect(shown({ shownAs: "door", type: "door" })).toBe("Shown as a door");
    expect(shown({ shownAs: "window", type: "window" })).toBe(
      "Shown as a window",
    );
    expect(shown({ shownAs: null, type: "contact" })).toBe(
      "Shown as a contact sensor",
    );
    // A type this build does not know.
    expect(shown({ shownAs: "gate", type: "gate" })).toBe(
      "Shown as another type",
    );
  });

  it("says a device on a battery went quiet, its battery fell low and it had a new one", () => {
    const device = { kind: "device" as const };
    expect(
      activityWords(
        clock,
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
        clock,
        entry({ action: "device.quiet", who: device, detail: null }),
        "device",
      ).detail,
    ).toBe("Not heard from");
    expect(
      activityWords(
        clock,
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
    // The device said so itself, at no charge that is low.
    expect(
      activityWords(
        clock,
        entry({ action: "device.battery.low", who: device }),
        "home",
      ),
    ).toEqual({
      title: "Lamp has a low battery",
      detail: "Replace it soon",
      problem: false,
    });
    expect(
      activityWords(
        clock,
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

  it("says what a smart speaker was asked by its moments, never its words", () => {
    const speaker = {
      type: "device" as const,
      id: "speaker",
      name: "Office Speaker",
      gone: false,
    };
    const asked = (fields: Partial<ActivityInfo>) =>
      activityWords(
        clock,
        entry({
          action: "device.request",
          subject: speaker,
          who: { kind: "speaker", id: "speaker", name: "Office Speaker" },
          detail: {
            firstSoundMs: 300,
            stoppedListeningMs: 2_400,
            replyReadyMs: 3_200,
            finishedPlayingMs: 4_000,
          },
          ...fields,
        }),
        "home",
      );
    expect(asked({})).toEqual({
      title: "Office Speaker answered a request",
      detail: "Listened 2.1 s, answered in 0.8 s, played 0.8 s",
      problem: false,
    });
    expect(
      asked({
        detail: {
          firstSoundMs: 300,
          stoppedListeningMs: 2_400,
          replyReadyMs: 7_400,
          finishedPlayingMs: 8_000,
          lateReplyMs: 9_100,
        },
      }).detail,
    ).toBe("Listened 2.1 s, answered after 9.1 s");
    expect(asked({ outcome: "failed", reason: "turn_ended" }).title).toBe(
      "Office Speaker stopped a request for a newer one",
    );
    expect(
      activityWords(
        clock,
        entry({
          action: "device.declined",
          outcome: "refused",
          reason: "assistant_off",
          subject: speaker,
          who: { kind: "sanctum" },
          detail: null,
        }),
        "device",
      ),
    ).toEqual({
      title: "Declined a voice request",
      detail: "The Assistant is off",
      problem: false,
    });
  });

  it("starts with the device's name in the home's list", () => {
    expect(activityWords(clock, entry(), "home").title).toBe(
      "Lamp turned on at 80%",
    );
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
      activityWords(clock, entry({ who: press, app: moods }), "device").detail,
    ).toBe("Office button, single press, with Moods");
    expect(
      activityWords(clock, entry({ who: press, run }), "device").detail,
    ).toBe("Office button, single press, through Desk focus");
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
        clock,
        entry({
          who: { kind: "workflow", id: "evening", name: "Evening" },
          run: sunset,
        }),
        "device",
      ).detail,
    ).toBe("Evening, 20 min before sunset");
    expect(
      activityWords(
        clock,
        entry({
          who: { kind: "client", id: "tablet", name: "Hallway tablet" },
        }),
        "device",
      ).detail,
    ).toBe("Hallway tablet");
    expect(
      activityWords(clock, entry({ who: { kind: "device" } }), "device").detail,
    ).toBe("Outside Sanctum, at the device or its switch");
  });

  it("writes the scheduled wall time in the home's hour format", () => {
    const zurich = homeClock({ timeZone: "Europe/Zurich", hourCycle: "12h" });
    const at = "2026-03-29T01:30:00Z";
    const trigger = { piece: "time", app: null };
    // The configured 02:30 is in the spring's missing hour.
    expect(triggerWords(zurich, { ...trigger, time: "02:30" }, at)).toBe(
      "at 2:30 AM",
    );
    expect(triggerWords(zurich, trigger, at)).toBe("at 3:30 AM");
  });

  it("joins a morning of adjustments into one", () => {
    const words = activityWords(
      clock,
      entry({
        count: 12,
        at: "2026-10-31T08:10:00",
        firstAt: "2026-10-31T07:05:00",
        who: {
          kind: "app",
          id: "sanctum.natural-light",
          name: "Natural Light",
        },
        app: { id: "sanctum.natural-light", name: "Natural Light" },
        detail: { asked: { brightness: 55 }, from: { brightness: 30 } },
      }),
      "device",
    );
    expect(words).toEqual({
      title: "Adjusted 12 times, 30% to 55%",
      detail: "Natural Light · 07:05–08:10",
      problem: false,
    });
  });

  it("says when a device didn't answer, as a problem", () => {
    expect(
      activityWords(
        clock,
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
    expect(
      activityWords(clock, entry({ outcome, reason, detail }), "device"),
    ).toEqual({ title, detail: "Alex · Sent again", problem });
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
    expect(activityWords(clock, left, "home")).toEqual({
      title: "Hall plug left the Zigbee network",
      detail: "Its network no longer has it, as after a reset",
      problem: false,
    });
    expect(activityWords(clock, { ...left, app: null }, "device").title).toBe(
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
    expect(activityWords(clock, found, "home")).toEqual({
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
    expect(activityWords(clock, repaired, "device")).toMatchObject({
      title,
      problem,
    });
  });

  it.each([
    ["ok", "Kitchen sensor added", false],
    ["refused", "Kitchen sensor couldn't be added", true],
  ] as const)(
    "says a found device was added (%s)",
    (outcome, title, problem) => {
      const added = entry({
        kind: "devices",
        action: "device.add",
        outcome,
        detail: { name: "Kitchen sensor" },
        subject: {
          type: "device",
          id: "sensor",
          name: "Kitchen sensor",
          gone: false,
        },
      });
      expect(activityWords(clock, added, "home")).toMatchObject({
        title,
        problem,
      });
    },
  );

  it("says what a press did", () => {
    const pressed = (fields: Partial<ActivityInfo>) =>
      activityWords(
        clock,
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
        clock,
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
        clock,
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
        clock,
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
        clock,
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
        clock,
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
        clock,
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
      activityWords(
        clock,
        home("device.home.add", { dashboard: "Home" }),
        "device",
      ).title,
    ).toBe("Added to Home");
    expect(
      activityWords(
        clock,
        home("device.home.remove", { dashboard: "Overview" }),
      ).title,
    ).toBe("Lamp removed from Overview");
    expect(
      activityWords(clock, {
        ...home("dashboard.order", null),
        subject: { type: "dashboard", id: "home", name: "Home", gone: false },
      }),
    ).toEqual({ title: "Rearranged Home", detail: "Alex", problem: false });
  });

  it("says an app's update and going back ended, by the name kept once it's gone", () => {
    const ended = (fields: Partial<ActivityInfo>) =>
      activityWords(
        clock,
        entry({
          kind: "system",
          source: "sanctum.moods",
          who: { kind: "sanctum" },
          app: moods,
          subject: null,
          detail: { name: "Moods", from: "0.10.0", to: "0.11.0" },
          ...fields,
        }),
      );
    expect(ended({ action: "version.update" })).toEqual({
      title: "Updated Moods to 0.11.0",
      detail: productName,
      problem: false,
    });
    expect(
      ended({ action: "version.update", outcome: "failed", reason: "crashed" }),
    ).toEqual({
      title: "Moods 0.11.0 didn't start",
      detail: "It went back to 0.10.0",
      problem: true,
    });
    expect(
      ended({
        action: "version.back",
        detail: { name: "Moods", from: "0.11.0", to: "0.10.0" },
      }).title,
    ).toBe("Moods went back to 0.10.0");
    expect(
      ended({
        action: "version.back",
        outcome: "failed",
        app: { id: "sanctum.moods", name: null },
        detail: { name: "Moods", from: "0.11.0", to: "0.10.0" },
      }),
    ).toEqual({
      title: "Moods couldn't go back to 0.10.0",
      detail: "It stayed on 0.11.0",
      problem: true,
    });
  });

  it("says who added an app, by the name kept once it's gone", () => {
    const added = (fields: Partial<ActivityInfo>) =>
      activityWords(
        clock,
        entry({
          kind: "setup",
          source: "sanctum.moods",
          action: "app.add",
          app: moods,
          subject: null,
          detail: { name: "Moods", version: "0.10.0" },
          ...fields,
        }),
      );
    expect(added({})).toEqual({
      title: "Added Moods",
      detail: "Alex",
      problem: false,
    });
    expect(
      added({ outcome: "refused", app: { id: "sanctum.moods", name: null } }),
    ).toEqual({ title: "Couldn't add Moods", detail: "Alex", problem: true });
  });

  it("reads an app's action by its title", () => {
    expect(
      activityWords(
        clock,
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
    expect(lastChangeWords(clock, entry({ at: "2026-10-31T21:52:00" }))).toBe(
      "Alex turned it on at 21:52",
    );
  });
});

import { describe, expect, it } from "vitest";

import {
  confirms,
  observe,
  prepare,
  reconcile,
  settle,
  shownState,
  type CapabilitySync,
} from "../src/devices/sync.js";

// Desired and observed state, and how they are reconciled.

const offLight: CapabilitySync = {
  kind: "light",
  features: {
    brightness: true,
    colorTemperature: { min: 153, max: 500 },
    color: true,
  },
  observed: {
    on: false,
    brightness: 80,
    colorMode: "temperature",
    colorTemperature: 370,
  },
  desired: null,
  sync: "synced",
};
const onLight: CapabilitySync = {
  ...offLight,
  observed: { ...offLight.observed, on: true },
};

describe("a command", () => {
  it("asks for state and goes to the driver", () => {
    expect(prepare(onLight, { brightness: 40 })).toEqual({
      desired: { on: true, brightness: 40 },
      sync: "pending",
      send: { on: true, brightness: 40 },
    });
  });

  it("turns a light off when it dims it to nothing", () => {
    expect(prepare(onLight, { brightness: 0 })).toMatchObject({
      desired: { on: false },
      send: { on: false },
    });
  });

  it("turns a light on when it dims it up", () => {
    expect(prepare(offLight, { brightness: 30 })).toMatchObject({
      desired: { on: true, brightness: 30 },
    });
  });

  it("leaves a light's brightness as it was when it turns it off", () => {
    expect(prepare(onLight, { on: false })).toEqual({
      desired: { on: false },
      sync: "pending",
      send: { on: false },
    });
  });

  it("sends only the off of one that says what the light comes back at", () => {
    expect(
      prepare(onLight, {
        on: false,
        brightness: 30,
        hue: 120,
        saturation: 80,
        transitionSeconds: 1,
      }),
    ).toEqual({
      desired: {
        on: false,
        brightness: 30,
        colorMode: "color",
        hue: 120,
        saturation: 80,
      },
      sync: "pending",
      send: { on: false, transitionSeconds: 1 },
    });
  });

  it("holds nothing once the off report confirms the requested look", () => {
    const prepared = prepare(onLight, {
      on: false,
      brightness: 80,
      colorTemperature: 370,
    });
    expect(prepared.send).toEqual({ on: false });
    expect(reconcile({ ...onLight, ...prepared }, offLight.observed!)).toEqual({
      desired: null,
      sync: "synced",
    });
    // What was held is not what it reports, so it is asked for again.
    const held: CapabilitySync = {
      ...offLight,
      desired: { brightness: 40 },
      sync: "held",
    };
    expect(prepare(held, { on: false, brightness: 40 }).desired).toEqual({
      on: false,
      brightness: 40,
    });
  });

  it("holds a colour for a light that is off until it turns on", () => {
    const held = prepare(offLight, { hue: 120, saturation: 80 });
    expect(held).toEqual({
      desired: { colorMode: "color", hue: 120, saturation: 80 },
      sync: "held",
      send: null,
    });

    const on = prepare(
      { ...offLight, ...held },
      { on: true, transitionSeconds: 1 },
    );
    expect(on).toEqual({
      desired: {
        on: true,
        brightness: 80,
        colorMode: "color",
        hue: 120,
        saturation: 80,
      },
      sync: "pending",
      send: {
        on: true,
        brightness: 80,
        hue: 120,
        saturation: 80,
        transitionSeconds: 1,
      },
    });
  });

  it("restores the original colour when a preview reports after cancellation", () => {
    const previewing = {
      ...offLight,
      ...prepare(offLight, {
        on: true,
        brightness: 40,
        hue: 240,
        saturation: 100,
      }),
    };
    const cancelling = {
      ...previewing,
      ...prepare(previewing, {
        on: false,
        brightness: 80,
        colorTemperature: 370,
      }),
    };
    const previewReport = observe(cancelling, {
      on: true,
      brightness: 40,
      colorMode: "color",
      hue: 240,
      saturation: 100,
    });
    const waiting = {
      ...cancelling,
      observed: previewReport,
      ...reconcile(cancelling, previewReport),
    };
    const off = observe(waiting, { ...previewReport, on: false });
    const restored = { ...waiting, observed: off, ...reconcile(waiting, off) };
    expect(prepare(restored, { on: true }).send).toEqual({
      on: true,
      brightness: 80,
      colorTemperature: 370,
    });
  });

  it("uses the restored look when turned on before the off report arrives", () => {
    const cancelling = {
      ...onLight,
      ...prepare(onLight, {
        on: false,
        brightness: 30,
        hue: 120,
        saturation: 80,
      }),
    };
    expect(prepare(cancelling, { on: true }).send).toEqual({
      on: true,
      brightness: 30,
      hue: 120,
      saturation: 80,
    });
    expect(
      prepare(cancelling, { brightness: 50, colorTemperature: 250 }).send,
    ).toEqual({
      on: true,
      brightness: 50,
      colorTemperature: 250,
    });
  });

  it("keeps the restored brightness and waits for off when its colour changes", () => {
    const cancelling = {
      ...onLight,
      ...prepare(onLight, {
        on: false,
        brightness: 30,
        hue: 120,
        saturation: 80,
      }),
    };
    const changed = prepare(cancelling, { colorTemperature: 250 });
    expect(changed).toEqual({
      desired: {
        on: false,
        brightness: 30,
        colorMode: "temperature",
        colorTemperature: 250,
      },
      sync: "pending",
      send: null,
    });
    expect(reconcile({ ...cancelling, ...changed }, onLight.observed!)).toEqual(
      {
        desired: changed.desired,
        sync: "pending",
      },
    );
    expect(prepare(cancelling, { on: false }).desired).toEqual({ on: false });
  });

  it("replaces a held colour with a held colour temperature", () => {
    const held: CapabilitySync = {
      ...offLight,
      desired: { colorMode: "color", hue: 120, saturation: 80 },
      sync: "held",
    };
    expect(prepare(held, { colorTemperature: 250 }).desired).toEqual({
      colorMode: "temperature",
      colorTemperature: 250,
    });
  });

  it("drops what was held when the light is turned off again", () => {
    const held: CapabilitySync = {
      ...offLight,
      desired: { colorMode: "color", hue: 120, saturation: 80 },
      sync: "held",
    };
    expect(prepare(held, { on: false }).desired).toEqual({ on: false });
  });

  it("goes out to a light whose state is not known yet", () => {
    const unknown: CapabilitySync = { ...offLight, observed: null };
    expect(prepare(unknown, { colorTemperature: 250 }).sync).toBe("pending");
  });

  it("goes to a switch as it is", () => {
    const plug: CapabilitySync = {
      kind: "switch",
      features: {},
      observed: { on: false },
      desired: null,
      sync: "synced",
    };
    expect(prepare(plug, { on: true })).toEqual({
      desired: { on: true },
      sync: "pending",
      send: { on: true },
    });
  });
});

describe("a report", () => {
  const pending: CapabilitySync = {
    ...offLight,
    desired: { on: true, brightness: 40 },
    sync: "pending",
  };

  it("confirms a pending command when it shows what was asked", () => {
    expect(reconcile(pending, { on: true, brightness: 40 })).toEqual({
      desired: null,
      sync: "synced",
    });
  });

  it("keeps a command pending while the device is on its way", () => {
    expect(reconcile(pending, { on: true, brightness: 70 })).toEqual({
      desired: pending.desired,
      sync: "pending",
    });
  });

  it("cannot confirm a field the device does not report, so it does not wait for it", () => {
    expect(confirms({ on: true }, { on: true, brightness: 40 })).toBe(true);
    expect(confirms({ on: false }, { on: true })).toBe(false);
  });

  it("keeps a held colour while the light stays off", () => {
    const held: CapabilitySync = {
      ...offLight,
      desired: { colorMode: "color", hue: 120, saturation: 80 },
      sync: "held",
    };
    expect(reconcile(held, { on: false, brightness: 80 })).toEqual({
      desired: held.desired,
      sync: "held",
    });
    // Reporting the colour itself confirms it.
    expect(
      reconcile(held, {
        on: false,
        colorMode: "color",
        hue: 120,
        saturation: 80,
      }),
    ).toEqual({ desired: null, sync: "synced" });
    // Turned on some other way, it shows what it reports.
    expect(reconcile(held, { on: true, brightness: 80 })).toEqual({
      desired: null,
      sync: "synced",
    });
  });

  it("holds what an off says the light comes back at once it reports off", () => {
    const turningOff: CapabilitySync = {
      ...onLight,
      desired: { on: false, brightness: 30 },
      sync: "pending",
    };
    expect(reconcile(turningOff, { on: true, brightness: 80 })).toEqual({
      desired: turningOff.desired,
      sync: "pending",
    });
    expect(reconcile(turningOff, { on: false, brightness: 80 })).toEqual({
      desired: { brightness: 30 },
      sync: "held",
    });
    // Unless it reports that already, as a plain off does.
    expect(reconcile(turningOff, { on: false, brightness: 30 })).toEqual({
      desired: null,
      sync: "synced",
    });
    expect(
      reconcile(
        { ...turningOff, desired: { on: false } },
        { on: false, brightness: 80 },
      ),
    ).toEqual({ desired: null, sync: "synced" });
  });

  it("clears a conflict", () => {
    expect(reconcile({ ...offLight, sync: "conflict" }, { on: false })).toEqual(
      { desired: null, sync: "synced" },
    );
  });
});

// Zigbee2MQTT publishes a light's previous state before the new one for
// every command, so a command sent right after another can first hear the
// light as it was before both (seen on the dev Pi, 2026-10-29).
describe("a report from before an earlier command", () => {
  const command = (capability: CapabilitySync, sent: Record<string, unknown>) =>
    ({ ...capability, ...prepare(capability, sent) }) as CapabilitySync;
  const report = (
    capability: CapabilitySync,
    sent: Record<string, unknown>,
  ) => {
    const observed = observe(capability, sent);
    return { ...capability, observed, ...reconcile(capability, observed) };
  };
  const reports = (
    capability: CapabilitySync,
    ...sent: Record<string, unknown>[]
  ) => sent.reduce(report, capability);

  const offAt70: CapabilitySync = {
    ...offLight,
    observed: { ...offLight.observed, brightness: 70 },
  };
  const before = {
    on: false,
    brightness: 70,
    colorMode: "temperature",
    colorTemperature: 370,
  };
  const preview = { on: true, brightness: 40, hue: 200, saturation: 80 };
  const previewed = { ...preview, colorMode: "color" };
  const putBackAsBefore = { on: false, brightness: 70, colorTemperature: 370 };
  // A mood's preview turns the light on, and Cancel puts it back off as it
  // was, both before the light has reported either.
  const cancelling = command(command(offAt70, preview), putBackAsBefore);

  it.each([
    ["with the look", before],
    ["without it", { on: false, brightness: 70 }],
  ])(
    "does not confirm an off while the light has not shown the earlier on (an echo %s)",
    (_, echo) => {
      const echoed = reports(cancelling, echo, echo);
      expect(echoed.sync).toBe("pending");
      const putBack = reports(
        echoed,
        previewed,
        previewed,
        previewed,
        previewed,
        { ...previewed, on: false },
        { ...previewed, on: false },
      );
      expect(putBack).toMatchObject({
        desired: {
          brightness: 70,
          colorMode: "temperature",
          colorTemperature: 370,
        },
        sync: "held",
      });
      expect(shownState(putBack)).toMatchObject(before);
      expect(prepare(putBack, { on: true }).send).toEqual({
        on: true,
        brightness: 70,
        colorTemperature: 370,
      });
    },
  );

  it("takes the earlier on's brightness as it reports it, not as a fade", () => {
    const off = command(command(offAt70, { on: true, brightness: 40 }), {
      on: false,
    });
    const turnedOn = reports(off, before, { on: true, brightness: 40 });
    expect(turnedOn).toMatchObject({
      observed: { on: true, brightness: 40 },
      sync: "pending",
    });
    // Its own reports while it fades out are.
    const turnedOff = reports(
      turnedOn,
      { on: true, brightness: 10 },
      { on: false, brightness: 1 },
    );
    expect(turnedOff).toMatchObject({
      observed: { on: false, brightness: 40 },
      desired: null,
      sync: "synced",
    });
  });

  it("waits for every on and off still on its way, in order", () => {
    // On, off, on and off again, before the light reports any of them.
    const lastOff = command(
      command(command(command(offAt70, preview), { on: false }), preview),
      putBackAsBefore,
    );
    const off = { ...previewed, on: false };
    expect(reports(lastOff, before, previewed, off).sync).toBe("pending");
    expect(
      reports(lastOff, before, previewed, off, previewed, off),
    ).toMatchObject({ desired: { brightness: 70 }, sync: "held" });
  });

  it("waits for nothing when the earlier command is confirmed or asks the same", () => {
    const confirmed = report(command(offAt70, { on: true, brightness: 40 }), {
      on: true,
      brightness: 40,
    });
    expect(reports(command(confirmed, { on: false }), before).sync).toBe(
      "synced",
    );
    // A brightness after an "on" turns it on too: the light's reports of
    // either confirm it, or not, as before.
    const dimmed = command(command(offAt70, { on: true, brightness: 40 }), {
      brightness: 60,
    });
    expect(report(dimmed, { on: true, brightness: 60 }).sync).toBe("synced");
  });

  it("leaves it to the light's last report once the command's time is up", () => {
    // A light that never showed the preview's on, or a driver that only
    // reports where a light ended.
    const echoed = reports(cancelling, before);
    expect(settle(echoed)).toEqual({
      desired: null,
      sync: "synced",
    });
    const stillOn = reports(cancelling, previewed);
    expect(settle(stillOn)).toEqual({ desired: null, sync: "conflict" });
  });

  it("orders a switch's reports too", () => {
    const plug: CapabilitySync = {
      kind: "switch",
      features: {},
      observed: { on: true },
      desired: null,
      sync: "synced",
    };
    const backOn = command(command(plug, { on: false }), { on: true });
    expect(report(backOn, { on: true }).sync).toBe("pending");
    expect(
      reports(backOn, { on: true }, { on: false }, { on: true }).sync,
    ).toBe("synced");
  });
});

// Many lights report their lowest level once off, and a plain "on" would
// bring them back almost dark.
describe("a light's brightness", () => {
  const lamp = (
    observed: Record<string, unknown> | null,
    features: Record<string, unknown> = { brightness: true },
  ): CapabilitySync => ({
    kind: "light",
    features,
    observed,
    desired: null,
    sync: "synced",
  });

  it("is remembered when the light reports off with none, and sent when it turns on", () => {
    const off = observe(lamp({ on: true, brightness: 80 }), {
      on: false,
      brightness: 0,
    });
    expect(off).toEqual({ on: false, brightness: 80 });
    expect(prepare(lamp(off), { on: true })).toEqual({
      desired: { on: true, brightness: 80 },
      sync: "pending",
      send: { on: true, brightness: 80 },
    });
  });

  it("is not overwritten by the lowest level a light reports once off", () => {
    expect(
      observe(lamp({ on: true, brightness: 80 }), { on: false, brightness: 1 }),
    ).toEqual({ on: false, brightness: 80 });
  });

  it("is kept when a light that is off reports none", () => {
    expect(observe(lamp({ on: true, brightness: 80 }), { on: false })).toEqual({
      on: false,
      brightness: 80,
    });
  });

  it("defaults to 100 for a light first seen off at its lowest level", () => {
    const off = observe(lamp(null), { on: false, brightness: 1 });
    expect(off).toEqual({ on: false, brightness: 100 });
    expect(prepare(lamp(off), { on: true }).send).toEqual({
      on: true,
      brightness: 100,
    });
  });

  it("is what a light first seen off reports, when that is more than its lowest level", () => {
    expect(observe(lamp(null), { on: false, brightness: 50 })).toEqual({
      on: false,
      brightness: 50,
    });
  });

  it("stays at 1% for a light that is on at 1%", () => {
    const onePercent = observe(lamp(null), { on: true, brightness: 1 });
    expect(onePercent).toEqual({ on: true, brightness: 1 });
    const prepared = prepare(lamp(onePercent), { on: true });
    expect(prepared.send).toEqual({ on: true });
    expect(shownState({ ...lamp(onePercent), ...prepared })).toEqual({
      on: true,
      brightness: 1,
    });
  });

  it("is never 0 for a light that is on", () => {
    expect(
      observe(lamp({ on: false, brightness: 60 }), { on: true, brightness: 0 }),
    ).toEqual({ on: true, brightness: 60 });
    expect(observe(lamp(null), { on: true, brightness: 0 })).toEqual({
      on: true,
      brightness: 100,
    });
  });

  it("gives way to what was asked or held", () => {
    expect(prepare(offLight, { on: true, brightness: 30 }).send).toEqual({
      on: true,
      brightness: 30,
    });
    const held: CapabilitySync = {
      ...offLight,
      desired: { brightness: 40 },
      sync: "held",
    };
    expect(prepare(held, { on: true }).send).toEqual({
      on: true,
      brightness: 40,
    });
  });

  it("is not sent to a light that is already on", () => {
    expect(prepare(onLight, { on: true }).send).toEqual({ on: true });
  });

  it("is sent again with an 'on' while the last one is still on its way", () => {
    const turningOn: CapabilitySync = {
      ...offLight,
      desired: { on: true, brightness: 80 },
      sync: "pending",
    };
    expect(prepare(turningOn, { on: true }).send).toEqual({
      on: true,
      brightness: 80,
    });
  });

  it("is not taken from a command the light has not confirmed", () => {
    // Dimmed to 20 while off; the light reports off before it gets the
    // command, which may still fail.
    const dimming: CapabilitySync = {
      ...offLight,
      desired: { on: true, brightness: 20 },
      sync: "pending",
    };
    expect(observe(dimming, { on: false, brightness: 1 })).toEqual({
      on: false,
      brightness: 80,
    });
  });

  it("comes back at 1% for a light that was at 1% before it went off", () => {
    // Set to 1% as a night light, then turned off.
    const off = observe(lamp({ on: true, brightness: 1 }), {
      on: false,
      brightness: 1,
    });
    expect(off).toEqual({ on: false, brightness: 1 });
    expect(observe(lamp(off), { on: false, brightness: 1 })).toEqual(off);
    expect(prepare(lamp(off), { on: true })).toEqual({
      desired: { on: true, brightness: 1 },
      sync: "pending",
      send: { on: true, brightness: 1 },
    });
  });

  it("is the one an off said, not the one the light had before it went off", () => {
    // Off at 70, turned on in blue at 40 by a mood's preview, then put back.
    const previewed = lamp(
      {
        on: true,
        brightness: 40,
        colorMode: "color",
        hue: 240,
        saturation: 100,
      },
      { brightness: true, color: true },
    );
    const putBack = prepare(previewed, { on: false, brightness: 70 });
    expect(putBack.send).toEqual({ on: false });
    const turningOff = { ...previewed, ...putBack };
    const off = observe(turningOff, { on: false, brightness: 1 });
    expect(off).toMatchObject({ on: false, brightness: 40 });
    const settled = {
      ...turningOff,
      observed: off,
      ...reconcile(turningOff, off),
    };
    expect(settled.sync).toBe("held");
    expect(shownState(settled)).toMatchObject({ on: false, brightness: 70 });
    expect(prepare(settled, { on: true }).send).toEqual({
      on: true,
      brightness: 70,
    });
  });

  it("is not taken from the levels a light fades through on its way off", () => {
    const turningOff: CapabilitySync = {
      ...lamp({ on: true, brightness: 80 }),
      desired: { on: false },
      sync: "pending",
    };
    const fading = observe(turningOff, { on: true, brightness: 1 });
    expect(fading).toEqual({ on: true, brightness: 80 });
    const off = observe(
      { ...turningOff, observed: fading },
      { on: false, brightness: 1 },
    );
    expect(off).toEqual({ on: false, brightness: 80 });
    expect(prepare(lamp(off), { on: true }).send).toEqual({
      on: true,
      brightness: 80,
    });
  });

  it("is kept when a report that the light is on leaves it out", () => {
    expect(observe(lamp({ on: false, brightness: 80 }), { on: true })).toEqual({
      on: true,
      brightness: 80,
    });
    // Such a report confirms a brightness still asked for, so it keeps that.
    const turningOn: CapabilitySync = {
      ...lamp({ on: false, brightness: 80 }),
      desired: { on: true, brightness: 60 },
      sync: "pending",
    };
    const observed = observe(turningOn, { on: true });
    expect(observed).toEqual({ on: true, brightness: 60 });
    expect(reconcile(turningOn, observed)).toEqual({
      desired: null,
      sync: "synced",
    });
  });

  it("is not made up for a light that cannot dim", () => {
    const onOff = { brightness: false };
    expect(observe(lamp({ on: true }, onOff), { on: false })).toEqual({
      on: false,
    });
    // Even when it once showed one, before its driver took the feature away.
    expect(
      prepare(lamp({ on: false, brightness: 80 }, onOff), { on: true }).send,
    ).toEqual({ on: true });
  });

  it("is 100 for a light that can dim and is first seen off with none", () => {
    expect(observe(lamp(null), { on: false })).toEqual({
      on: false,
      brightness: 100,
    });
  });

  it("leaves a switch alone", () => {
    const plug: CapabilitySync = {
      kind: "switch",
      features: {},
      observed: { on: true },
      desired: null,
      sync: "synced",
    };
    expect(observe(plug, { on: false })).toEqual({ on: false });
  });
});

describe("a command the device does not confirm in time", () => {
  it("ends in conflict, showing what the device reports", () => {
    const pending: CapabilitySync = {
      ...onLight,
      desired: { on: false },
      sync: "pending",
    };
    expect(settle(pending)).toEqual({ desired: null, sync: "conflict" });
  });

  it("keeps a colour for a light that is off, held for when it turns on", () => {
    const pending: CapabilitySync = {
      ...offLight,
      desired: { colorMode: "color", hue: 120, saturation: 80 },
      sync: "pending",
    };
    expect(settle(pending)).toEqual({ desired: pending.desired, sync: "held" });
  });

  it("leaves anything that is not pending", () => {
    expect(settle({ ...offLight, sync: "conflict" }).sync).toBe("conflict");
  });
});

describe("what clients show", () => {
  it("is the reported state with what is pending or held applied", () => {
    expect(
      shownState({ ...offLight, desired: { on: true }, sync: "pending" }),
    ).toEqual({ ...offLight.observed, on: true });
    expect(shownState(offLight)).toEqual(offLight.observed);
  });

  it("is what was asked of a device that has not reported, once that is a whole state", () => {
    const unknown = { ...offLight, observed: null };
    expect(
      shownState({ ...unknown, desired: { on: true }, sync: "pending" }),
    ).toEqual({
      on: true,
    });
    expect(
      shownState({ ...unknown, desired: { brightness: 40 }, sync: "pending" }),
    ).toBeNull();
  });
});

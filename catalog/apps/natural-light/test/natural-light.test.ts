import {
  defineApp,
  toStaticManifest,
  type ActionDefinition,
  type Actor,
} from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import { checkJob, createNaturalLightApp } from "../src/index.js";
import {
  brightnessPercent,
  clampMired,
  colorTemperatureKelvin,
  kelvinToMired,
  type CurveSettings,
} from "../src/curve.js";
import { defaultCurve } from "../src/settings.js";
import { sunToday } from "../src/sun.js";
import { fakeCore, zurich } from "./fake-core.js";

// Lights following the curve: a light that follows it is set to it at once,
// kept on it as the day goes, comes back on at it, and is paused while a
// mood or a person has set it, until it is switched off.

const appId = "sanctum.natural-light";
const maya: Actor = { kind: "user", id: "maya" };
const moods = { app: "sanctum.moods", actor: maya };
const byHand = { app: null, actor: maya };
const minute = 60_000;
const lamp = { device: "lamp", capability: "light" };
const range = { min: 153, max: 454 };
const on = { on: true, brightness: 100, colorMode: "temperature" as const };
const off = { ...on, on: false };

// What the curve sets a light with the fake core's range to at a moment.
function curveAt(now: Date, curve: CurveSettings = defaultCurve) {
  const sun = sunToday(zurich, now)!;
  return {
    colorTemperature: clampMired(
      kelvinToMired(colorTemperatureKelvin(curve, sun, now)),
      range,
    ),
    brightness: brightnessPercent(curve, sun, now),
  };
}

function running() {
  // Mid-morning in Zurich, with the curve rising towards noon.
  const clock = { now: Date.parse("2026-10-29T09:00:00Z") };
  const now = () => new Date(clock.now);
  const app = createNaturalLightApp({ now });
  const core = fakeCore(app, now);

  async function call(id: string, input: object, actor: Actor = maya) {
    const action = app.actions.find(
      (each) => each.id === id,
    ) as ActionDefinition;
    const output = await action.run(core.as(actor), action.input.parse(input));
    return action.output.parse(output);
  }

  return {
    app,
    core,
    call,
    // The app's job, as the core runs it: as the app itself.
    check: () => call("naturalLight.check", {}, { kind: "app", id: appId }),
    now,
    advance: (ms: number) => (clock.now += ms),
    target: () => core.state.entities.get("lamp/light")?.state,
    // The commands the app sent from the n-th on.
    sentFrom: (index: number) =>
      core.state.sent.slice(index).map(({ command }) => command),
  };
}

describe("following the curve", () => {
  it("sets a light to the curve as soon as it follows, and says so", async () => {
    const { core, call, now, target } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });

    const followed = await call("naturalLight.follow", {
      ...lamp,
      follow: true,
    });

    expect(core.state.sent).toEqual([
      { device: "lamp", command: curveAt(now()), actor: maya },
    ]);
    const expected = {
      ...lamp,
      status: "following",
      ...curveAt(now()),
    };
    expect(followed).toEqual(expected);
    expect(core.state.entities.get("lamp/light")).toEqual({
      type: "naturalLight.target",
      name: "Office light",
      state: expected,
    });
    expect(target()).toEqual(expected);
    expect(core.light("lamp").setBy).toMatchObject({ app: appId });
  });

  it("has a light that is off come back on at the curve, whoever switches it", async () => {
    const { core, call, check, now, sentFrom } = running();
    core.addLight("lamp", "Office light", { ...off, colorTemperature: 153 });

    await call("naturalLight.follow", { ...lamp, follow: true });
    expect(sentFrom(0)).toEqual([{ on: false, ...curveAt(now()) }]);

    core.set("lamp", { on: true }, moods);
    await check();

    expect(core.light("lamp").state).toMatchObject({
      on: true,
      ...curveAt(now()),
    });
    expect(sentFrom(1)).toEqual([]);
  });

  it("keeps lights on the curve: those on every 5 minutes, those off every 15", async () => {
    const { core, call, check, advance, now, sentFrom } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    core.addLight("hall", "Hall light", { ...off, colorTemperature: 153 });
    await call("naturalLight.follow", { ...lamp, follow: true });
    await call("naturalLight.follow", {
      device: "hall",
      capability: "light",
      follow: true,
    });

    advance(4 * minute);
    await check();
    expect(sentFrom(2)).toEqual([]);

    // A job's beat can come a moment before the light is due.
    advance(minute - 1000);
    await check();
    expect(core.state.sent.slice(2)).toEqual([
      {
        device: "lamp",
        command: curveAt(now()),
        actor: { kind: "app", id: appId },
      },
    ]);

    advance(10 * minute);
    await check();
    expect(sentFrom(3)).toEqual([
      curveAt(now()),
      { on: false, ...curveAt(now()) },
    ]);
  });

  it("leaves a light alone that already shows the curve, or is offline", async () => {
    const { core, call, check, advance, sentFrom } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    await call("naturalLight.follow", { ...lamp, follow: true });

    core.state.devices[0]!.availability = "offline";
    advance(20 * minute);
    await check();
    expect(sentFrom(1)).toEqual([]);

    // At night the curve stays put.
    core.state.devices[0]!.availability = "online";
    advance(10 * 60 * minute);
    await check();
    await check();
    advance(10 * minute);
    await check();
    expect(sentFrom(1)).toHaveLength(1);
  });

  it("waits for the home's location", async () => {
    const { core, call, check, advance, now, target, sentFrom } = running();
    core.state.location = null;
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });

    await call("naturalLight.follow", { ...lamp, follow: true });
    expect(sentFrom(0)).toEqual([]);
    expect(target()).toEqual({
      ...lamp,
      status: "waiting",
      colorTemperature: null,
      brightness: null,
    });

    // Switching it meanwhile pauses nothing.
    advance(1000);
    core.set("lamp", { on: false }, byHand);
    core.set("lamp", { on: true }, byHand);
    core.state.location = zurich;
    await check();
    expect(sentFrom(0)).toEqual([curveAt(now())]);
    expect(target()).toMatchObject({ status: "following" });
  });
});

describe("pausing", () => {
  async function following() {
    const context = running();
    context.core.addLight("lamp", "Office light", {
      ...on,
      colorTemperature: 153,
    });
    await context.call("naturalLight.follow", { ...lamp, follow: true });
    // What it set the light to.
    const applied = curveAt(context.now());
    context.advance(1000);
    return { ...context, applied };
  }

  it("pauses a light a mood sets, until it is switched off", async () => {
    const { core, check, advance, now, target, sentFrom } = await following();

    core.set(
      "lamp",
      { on: true, brightness: 40, colorTemperature: 400 },
      moods,
    );
    await check();
    advance(30 * minute);
    await check();

    expect(target()).toMatchObject({ status: "paused" });
    expect(sentFrom(1)).toEqual([]);
    expect(core.light("lamp").state).toMatchObject({
      brightness: 40,
      colorTemperature: 400,
    });

    core.set("lamp", { on: false }, moods);
    await check();
    expect(target()).toMatchObject({ status: "following" });
    expect(sentFrom(1)).toEqual([{ on: false, ...curveAt(now()) }]);

    core.set("lamp", { on: true }, byHand);
    expect(core.light("lamp").state).toMatchObject(curveAt(now()));
  });

  it("pauses for a person's own change, but not for switching alone", async () => {
    const { core, check, target } = await following();

    core.set("lamp", { on: false }, byHand);
    await check();
    core.set("lamp", { on: true }, byHand);
    await check();
    expect(target()).toMatchObject({ status: "following" });

    core.set("lamp", { brightness: 30 }, byHand);
    await check();
    expect(target()).toMatchObject({ status: "paused" });
  });

  it("is not paused by its own look put back, as after a mood preview", async () => {
    const { core, check, applied, target } = await following();

    core.set("lamp", { on: true, ...applied }, moods);
    await check();

    expect(target()).toMatchObject({ status: "following" });
  });

  it("recognizes the curve it adopted without sending a command", async () => {
    const { core, call, check, advance, now, target, sentFrom } = running();
    const applied = curveAt(now());
    core.addLight("lamp", "Office light", { ...on, ...applied });
    await call("naturalLight.follow", { ...lamp, follow: true });
    expect(sentFrom(0)).toEqual([]);

    advance(1000);
    core.set(
      "lamp",
      { on: true, brightness: 40, colorTemperature: 400 },
      moods,
    );
    core.set("lamp", { on: true, ...applied }, moods);
    await check();

    expect(target()).toMatchObject({ status: "following" });
  });

  it("brings a light that was switched off and on meanwhile back to the curve", async () => {
    const { core, check, now, target, sentFrom } = await following();
    core.set(
      "lamp",
      { on: true, brightness: 40, colorTemperature: 400 },
      moods,
    );
    await check();

    // Off and on between two checks: the look the mood left comes back.
    core.set("lamp", { on: false }, byHand);
    core.set("lamp", { on: true }, byHand);
    await check();

    expect(target()).toMatchObject({ status: "following" });
    expect(sentFrom(1)).toEqual([curveAt(now())]);
  });

  it("pauses and resumes on purpose", async () => {
    const { call, check, advance, now, sentFrom } = await following();

    expect(await call("naturalLight.pause", lamp)).toMatchObject({
      status: "paused",
    });
    advance(30 * minute);
    await check();
    expect(sentFrom(1)).toEqual([]);

    expect(await call("naturalLight.resume", lamp)).toMatchObject({
      status: "following",
    });
    expect(sentFrom(1)).toEqual([curveAt(now())]);
  });

  it("ends a pause on purpose once the light is switched off", async () => {
    const { core, call, check, target } = await following();
    await call("naturalLight.pause", lamp);

    core.press("lamp", { on: false });
    await check();
    core.press("lamp", { on: true });
    await check();

    expect(target()).toMatchObject({ status: "following" });
  });

  it("keeps following after an explicit pause ends between checks", async () => {
    const { core, call, check, advance, now, target } = await following();
    await call("naturalLight.pause", lamp);

    advance(10 * minute);
    core.set("lamp", { on: false }, byHand);
    core.set("lamp", { on: true }, byHand);
    await check();
    expect(target()).toMatchObject({ status: "following" });

    advance(5 * minute);
    await check();
    expect(target()).toMatchObject({ status: "following" });
    expect(core.light("lamp").state).toMatchObject(curveAt(now()));
  });

  it("resumes a light a mood paused", async () => {
    const { core, call, now, target } = await following();
    core.set(
      "lamp",
      { on: true, brightness: 40, colorTemperature: 400 },
      moods,
    );

    await call("naturalLight.resume", lamp);

    expect(core.light("lamp").state).toMatchObject(curveAt(now()));
    expect(target()).toMatchObject({ status: "following" });
  });

  it("keeps an explicit pause when resuming fails", async () => {
    const { core, call, check, advance, target, sentFrom } = await following();
    await call("naturalLight.pause", lamp);
    advance(10 * minute);
    core.state.beforeCommand = async () => {
      throw new Error("radio failed");
    };
    await expect(call("naturalLight.resume", lamp)).rejects.toThrow(
      "radio failed",
    );

    core.state.beforeCommand = null;
    await check();
    expect(target()).toMatchObject({ status: "paused" });
    expect(sentFrom(1)).toEqual([]);
  });
});

describe("which lights follow", () => {
  it("stops following a light when asked", async () => {
    const { core, call, check, advance, target, sentFrom } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    await call("naturalLight.follow", { ...lamp, follow: true });

    expect(
      await call("naturalLight.follow", { ...lamp, follow: false }),
    ).toBeNull();
    advance(20 * minute);
    await check();

    expect(target()).toBeUndefined();
    expect(sentFrom(1)).toEqual([]);
  });

  it("forgets a light that leaves the home", async () => {
    const { core, call, check, target } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    await call("naturalLight.follow", { ...lamp, follow: true });

    core.state.devices.length = 0;
    await check();

    expect(target()).toBeUndefined();
    await expect(call("naturalLight.resume", lamp)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("refuses a light that takes no colour temperature", async () => {
    const { core, call } = running();
    core.addLight(
      "lamp",
      "Office light",
      { on: true, brightness: 100 },
      { brightness: true, colorTemperature: null, color: false },
    );

    await expect(
      call("naturalLight.follow", { ...lamp, follow: true }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("does not set a light again that follows already", async () => {
    const { core, call, advance, sentFrom } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    await call("naturalLight.follow", { ...lamp, follow: true });
    advance(1000);
    core.set(
      "lamp",
      { on: true, brightness: 40, colorTemperature: 400 },
      moods,
    );

    expect(
      await call("naturalLight.follow", { ...lamp, follow: true }),
    ).toMatchObject({ status: "paused" });
    expect(sentFrom(1)).toEqual([]);
  });

  it("accepts concurrent requests to follow the same light", async () => {
    const { core, call, target } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });

    await Promise.all([
      call("naturalLight.follow", { ...lamp, follow: true }),
      call("naturalLight.follow", { ...lamp, follow: true }),
    ]);

    expect(target()).toMatchObject({ status: "following" });
    expect(core.state.sent).toHaveLength(1);
  });

  it("does not let a delayed check restore a light after following stops", async () => {
    const { core, call, check, advance, target } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    await call("naturalLight.follow", { ...lamp, follow: true });
    advance(5 * minute);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const delivery = new Promise<void>((resolve) => (release = resolve));
    core.state.beforeCommand = () => {
      enter();
      return delivery;
    };

    const checking = check();
    await entered;
    const stopping = call("naturalLight.follow", { ...lamp, follow: false });
    release();
    await Promise.all([checking, stopping]);

    expect(target()).toBeUndefined();
    core.state.beforeCommand = null;
    advance(5 * minute);
    await check();
    expect(target()).toBeUndefined();
  });

  it("does not keep following after the initial command fails", async () => {
    const { core, call, check, advance, target } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    core.state.beforeCommand = async () => {
      throw new Error("radio failed");
    };
    await expect(
      call("naturalLight.follow", { ...lamp, follow: true }),
    ).rejects.toThrow("radio failed");

    core.state.beforeCommand = null;
    advance(5 * minute);
    await check();
    expect(target()).toBeUndefined();
    expect(core.state.sent).toEqual([]);

    await call("naturalLight.follow", { ...lamp, follow: true });
    expect(target()).toMatchObject({ status: "following" });
  });
});

describe("the curve the household sets", () => {
  it("is what lights follow, from the next check on", async () => {
    const { core, call, check, advance, now, sentFrom } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    await call("naturalLight.follow", { ...lamp, follow: true });

    core.state.settings = { highKelvin: 4000, highBrightness: 90 };
    advance(5 * minute);
    await check();

    expect(sentFrom(1)).toEqual([
      curveAt(now(), { ...defaultCurve, highKelvin: 4000, highBrightness: 90 }),
    ]);
  });

  it("holds the night's look for a light that is off, at night", async () => {
    const { core, call, advance, sentFrom } = running();
    core.addLight("lamp", "Office light", { ...off, colorTemperature: 153 });
    core.state.settings = { lowKelvin: 2700, lowBrightness: 50 };
    // 21:00 in Zurich.
    advance(11 * 60 * minute);

    await call("naturalLight.follow", { ...lamp, follow: true });

    expect(sentFrom(0)).toEqual([
      { on: false, colorTemperature: kelvinToMired(2700), brightness: 50 },
    ]);
  });

  it("reaches every light at once when the household changes it, even one set a moment ago", async () => {
    const { app, core, call, now, sentFrom } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    await call("naturalLight.follow", { ...lamp, follow: true });
    await app.start!(core.ctx, { reason: "started" });
    const changed = { ...defaultCurve, highKelvin: 4000, highBrightness: 90 };

    await core.changeSettings({ highKelvin: 4000, highBrightness: 90 });

    await vi.waitFor(() =>
      expect(sentFrom(1)).toEqual([curveAt(now(), changed)]),
    );
    expect(core.state.entities.get("lamp/light")?.state).toMatchObject({
      status: "following",
      ...curveAt(now(), changed),
    });
    await app.stop!(core.ctx, { reason: "shutdown" });
  });

  it("is taken by nothing once natural light stops", async () => {
    const { app, core, call, sentFrom } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    await call("naturalLight.follow", { ...lamp, follow: true });
    await app.start!(core.ctx, { reason: "started" });
    await app.stop!(core.ctx, { reason: "shutdown" });

    await core.changeSettings({ highKelvin: 4000 });
    await new Promise((done) => setTimeout(done, 20));

    expect(sentFrom(1)).toEqual([]);
  });

  it("shapes the preview", async () => {
    const { core, call } = running();
    core.state.settings = { shape: "early_riser", sunriseOffsetMinutes: 30 };

    const preview = (await call("naturalLight.preview", {})) as {
      curve: CurveSettings;
      peak: string;
      solarNoon: string;
    };

    expect(preview.curve).toEqual({
      ...defaultCurve,
      shape: "early_riser",
      sunriseOffsetMinutes: 30,
    });
    expect(Date.parse(preview.peak)).toBeLessThan(
      Date.parse(preview.solarNoon),
    );
  });
});

describe("the preview", () => {
  it("is today's curve once the home has a location", async () => {
    const { core, call, now } = running();

    core.state.location = null;
    expect(await call("naturalLight.preview", {})).toBeNull();

    core.state.location = zurich;
    expect(await call("naturalLight.preview", {})).toMatchObject({
      date: "2026-10-29",
      timeZone: "Europe/Zurich",
      now: { at: now().toISOString() },
    });
  });
});

describe("natural light", () => {
  it("checks every 5 minutes as its job, from when it starts", async () => {
    const { core, app } = running();

    await app.start!(core.ctx, { reason: "started" });
    await app.start!(core.ctx, { reason: "started" });

    expect(core.state.jobs).toEqual([
      {
        key: checkJob,
        action: "naturalLight.check",
        input: {},
        when: { every: 300 },
        nextAt: null,
      },
    ]);
  });

  it("publishes where each light it follows stands as it starts, from its own database, setting none", async () => {
    const { app, core, call, advance, sentFrom, now } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    core.addLight("desk", "Desk lamp", { ...on, colorTemperature: 153 });
    await call("naturalLight.follow", { ...lamp, follow: true });
    await call("naturalLight.follow", {
      device: "desk",
      capability: "light",
      follow: true,
    });
    advance(minute);
    core.set("desk", { hue: 30, saturation: 80 }, moods);
    // A core put back, holding none of what the app owns.
    core.state.entities.clear();

    await app.start!(core.ctx, { reason: "started" });

    expect(sentFrom(2)).toEqual([]);
    expect(Object.fromEntries(core.state.entities)).toEqual({
      "lamp/light": expect.objectContaining({
        state: {
          device: "lamp",
          capability: "light",
          status: "following",
          ...curveAt(now()),
        },
      }),
      "desk/light": expect.objectContaining({
        state: expect.objectContaining({ status: "paused" }),
      }),
    });
    await app.stop!(core.ctx, { reason: "shutdown" });
  });

  it("publishes where each light it follows stands again when it resumes, setting none", async () => {
    const { app, core, call, advance, sentFrom, now } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    await call("naturalLight.follow", { ...lamp, follow: true });
    await app.start!(core.ctx, { reason: "started" });
    advance(minute);
    // What the core missed while it was away.
    core.state.entities.clear();
    const sent = sentFrom(0).length;

    await app.resume!(core.ctx, { reason: "started" });

    expect(sentFrom(sent)).toEqual([]);
    expect(core.state.entities.get("lamp/light")?.state).toEqual({
      device: "lamp",
      capability: "light",
      status: "following",
      ...curveAt(now()),
    });
    await app.stop!(core.ctx, { reason: "shutdown" });
  });

  it.each(["read", "publish"] as const)(
    "fails its start when it cannot %s a followed light's target",
    async (operation) => {
      const { app, core, call, sentFrom } = running();
      core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
      await call("naturalLight.follow", { ...lamp, follow: true });
      const failure = new Error("The core call failed");
      if (operation === "read") {
        vi.spyOn(core.ctx.devices, "state").mockRejectedValue(failure);
      } else {
        vi.spyOn(core.ctx.entities, "publish").mockRejectedValue(failure);
      }

      await expect(app.start!(core.ctx, { reason: "started" })).rejects.toThrow(
        failure,
      );

      expect(sentFrom(1)).toEqual([]);
      await app.stop!(core.ctx, { reason: "shutdown" });
    },
  );

  it("declares what it brings and the lights it controls", () => {
    const manifest = toStaticManifest(defineApp(createNaturalLightApp()));

    expect(manifest.permissions.map(({ id, needed }) => [id, needed])).toEqual([
      ["places.location", true],
      ["devices.control:light", true],
    ]);
    expect(manifest.provides.entities.map((type) => type.id)).toEqual([
      "naturalLight.target",
    ]);
    expect(Object.keys(manifest.settings?.properties ?? {})).toEqual([
      "shape",
      "lowKelvin",
      "highKelvin",
      "lowBrightness",
      "highBrightness",
      "sunriseOffsetMinutes",
      "sunsetOffsetMinutes",
    ]);
    expect(manifest.actions.map((action) => action.id)).toEqual([
      "naturalLight.follow",
      "naturalLight.resume",
      "naturalLight.pause",
      "naturalLight.preview",
      "naturalLight.check",
    ]);
    // Each with its words, and a light for their {device} on its
    // settings page.
    expect(manifest.provides.steps).toEqual([
      {
        id: "naturalLight.follow",
        words: expect.objectContaining({
          presets: [
            expect.objectContaining({
              sentence: "Let {device} follow natural light",
            }),
            expect.objectContaining({
              sentence: "Stop {device} following natural light",
            }),
          ],
          preview: { device: "Desk lamp" },
        }),
        needs: [],
      },
      {
        id: "naturalLight.pause",
        words: {
          sentence: "Pause natural light on {device}",
          preview: { device: "Desk lamp" },
        },
        needs: [],
      },
      {
        id: "naturalLight.resume",
        words: {
          sentence: "Resume natural light on {device}",
          preview: { device: "Desk lamp" },
        },
        needs: [],
      },
    ]);
  });
});

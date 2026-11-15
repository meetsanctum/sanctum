import { describe, expect, it, vi } from "vitest";

import {
  byHand,
  curveAt,
  lamp,
  minute,
  moods,
  off,
  on,
  running,
} from "./running.js";

// Every light that takes a colour temperature follows natural light unless
// the household leaves it out, a light added to the home too; and a switch
// in its settings turns natural light off altogether, keeping the choices.

const stripFeatures = {
  brightness: true,
  colorTemperature: null,
  color: false,
};

describe("following by default", () => {
  it("takes in every light that takes a colour temperature as it starts, setting none until its check", async () => {
    const { app, core, check, now, sentFrom, target } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    core.addLight("strip", "Shelf strip", { on: true }, stripFeatures);

    await app.start!(core.ctx, { reason: "started" });

    expect(sentFrom(0)).toEqual([]);
    expect([...core.state.entities.keys()]).toEqual(["lamp/light"]);
    expect(target()).toMatchObject({ status: "following", ...curveAt(now()) });

    await check();
    expect(sentFrom(0)).toEqual([curveAt(now())]);
    await app.stop!(core.ctx, { reason: "shutdown" });
  });

  it("leaves a light a mood set as it is, until it is switched off", async () => {
    const { core, check, advance, now, sentFrom, target } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    core.set("lamp", { colorTemperature: 300, brightness: 40 }, moods);

    await check();
    expect(sentFrom(0)).toEqual([]);
    expect(target()).toMatchObject({ status: "paused" });

    core.set("lamp", { on: false }, byHand);
    advance(minute);
    await check();
    expect(sentFrom(0)).toEqual([{ on: false, ...curveAt(now()) }]);
    expect(target()).toMatchObject({ status: "following" });
  });

  it("follows a light added to the home at once", async () => {
    const { app, core, now, sentFrom, target } = running();
    await app.start!(core.ctx, { reason: "started" });

    await core.joins("lamp", "Office light", { ...on, colorTemperature: 153 });

    await vi.waitFor(() => expect(sentFrom(0)).toEqual([curveAt(now())]));
    expect(target()).toMatchObject({ status: "following" });
    await app.stop!(core.ctx, { reason: "shutdown" });
  });

  it("keeps a light the household left out, until it is to follow again", async () => {
    const { core, call, check, advance, now, sentFrom, target } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    await call("naturalLight.follow", { ...lamp, follow: false });

    advance(5 * minute);
    await check();
    expect(target()).toBeUndefined();
    expect(sentFrom(0)).toEqual([]);

    await call("naturalLight.follow", { ...lamp, follow: true });
    expect(sentFrom(0)).toEqual([curveAt(now())]);
    expect(target()).toMatchObject({ status: "following" });
  });

  it("lets go of a light it leaves out while holding the light's look", async () => {
    const { core, call, check, now, sentFrom } = running();
    core.addLight("lamp", "Office light", { ...off, colorTemperature: 153 });
    await check();
    expect(sentFrom(0)).toEqual([{ on: false, ...curveAt(now()) }]);

    await call("naturalLight.follow", { ...lamp, follow: false });

    expect(sentFrom(1)).toEqual([{ on: false }]);
  });
});

describe("switching natural light off", () => {
  it("keeps a delayed check from restoring the curve after it is switched off", async () => {
    const { app, core, check, advance, sentFrom, target } = running();
    core.addLight("lamp", "Office light", { ...off, colorTemperature: 153 });
    await app.start!(core.ctx, { reason: "started" });
    await check();
    advance(15 * minute);

    const context = core.as({ kind: "app", id: app.id });
    vi.spyOn(core, "as").mockReturnValue(context);
    const list = context.devices.list.bind(context.devices);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    const delivery = new Promise<void>((resolve) => (release = resolve));
    vi.spyOn(context.devices, "list").mockImplementation(async () => {
      enter();
      await delivery;
      return list();
    });

    const checking = check();
    await entered;
    await core.changeSettings({ on: false });
    await vi.waitFor(() => expect(target()).toMatchObject({ status: "off" }));
    const sent = core.state.sent.length;
    release();
    await checking;

    expect(target()).toMatchObject({ status: "off" });
    expect(sentFrom(sent)).toEqual([]);
    await app.stop!(core.ctx, { reason: "shutdown" });
  });

  it("lets go of every light, and changes none with the day", async () => {
    const { app, core, check, advance, sentFrom } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    core.addLight("desk", "Desk lamp", { ...off, colorTemperature: 153 });
    await app.start!(core.ctx, { reason: "started" });
    await check();
    const sent = core.state.sent.length;

    await core.changeSettings({ on: false });

    await vi.waitFor(() =>
      expect(core.state.entities.get("lamp/light")?.state).toMatchObject({
        status: "off",
        colorTemperature: null,
        brightness: null,
      }),
    );
    expect(core.state.entities.get("desk/light")?.state).toMatchObject({
      status: "off",
    });
    // Only the light that held natural light's look while off.
    expect(core.state.sent.slice(sent)).toEqual([
      expect.objectContaining({ device: "desk", command: { on: false } }),
    ]);

    advance(20 * minute);
    await check();
    expect(sentFrom(sent)).toEqual([{ on: false }]);
    await app.stop!(core.ctx, { reason: "shutdown" });
  });

  it("keeps the household's choices while off, and sets nothing", async () => {
    const { core, call, check, sentFrom, target } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    core.state.settings = { on: false };

    await call("naturalLight.follow", { ...lamp, follow: true });
    expect(target()).toMatchObject({ status: "off" });

    await call("naturalLight.follow", { ...lamp, follow: false });
    await check();
    expect(target()).toBeUndefined();
    expect(sentFrom(0)).toEqual([]);
  });

  it("has every light take the curve at once when switched on again, whatever was set while it was off", async () => {
    const { app, core, check, now, sentFrom, target } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    await app.start!(core.ctx, { reason: "started" });
    await check();
    await core.changeSettings({ on: false });
    await vi.waitFor(() => expect(target()).toMatchObject({ status: "off" }));
    core.set("lamp", { colorTemperature: 300, brightness: 40 }, moods);
    const sent = core.state.sent.length;

    await core.changeSettings({ on: true });

    await vi.waitFor(() => expect(sentFrom(sent)).toEqual([curveAt(now())]));
    expect(target()).toMatchObject({ status: "following", ...curveAt(now()) });
    await app.stop!(core.ctx, { reason: "shutdown" });
  });
});

describe("a room's switch", () => {
  function home() {
    const run = running();
    const { core } = run;
    core.addLight("ceiling", "Ceiling", { ...on, colorTemperature: 153 });
    core.addLight("desk", "Desk lamp", { ...on, colorTemperature: 153 });
    core.addLight("strip", "Shelf strip", { on: true }, stripFeatures);
    core.addLight("hall", "Hall light", { ...on, colorTemperature: 153 });
    core.addLight("loose", "Loose lamp", { ...on, colorTemperature: 153 });
    const rooms: Record<string, string | null> = {
      ceiling: "office",
      desk: "office",
      strip: "office",
      hall: "hall",
      loose: null,
    };
    for (const device of core.state.devices) device.roomId = rooms[device.id]!;
    const following = () =>
      [...core.state.entities.keys()].map((key) => key.split("/")[0]).sort();
    return { ...run, following };
  }

  it("leaves out every light in the room, or has them all follow again", async () => {
    const { call, check, now, sentFrom, following } = home();

    expect(
      await call("naturalLight.followRoom", {
        placeId: "office",
        follow: false,
      }),
    ).toEqual({ failed: [] });
    await check();
    expect(following()).toEqual(["hall", "loose"]);
    const sent = sentFrom(0).length;

    expect(
      await call("naturalLight.followRoom", {
        placeId: "office",
        follow: true,
      }),
    ).toEqual({ failed: [] });
    expect(following()).toEqual(["ceiling", "desk", "hall", "loose"]);
    // Both take the curve at once; the strip takes no colour temperature.
    expect(sentFrom(sent)).toEqual([curveAt(now()), curveAt(now())]);
  });

  it("leaves out a light that still follows though it no longer takes a colour temperature", async () => {
    const { core, call, check, following } = home();
    await check();
    core.light("desk").features = stripFeatures;

    await call("naturalLight.followRoom", { placeId: "office", follow: false });

    expect(following()).toEqual(["hall", "loose"]);
  });

  it("covers the lights in no room for no room", async () => {
    const { call, check, following } = home();
    await check();

    await call("naturalLight.followRoom", { placeId: null, follow: false });

    expect(following()).toEqual(["ceiling", "desk", "hall"]);
  });

  it("names a light it couldn't change, and changes the others", async () => {
    const { core, call, following } = home();
    await call("naturalLight.followRoom", { placeId: "office", follow: false });
    let refused = false;
    core.state.beforeCommand = async () => {
      if (!refused) {
        refused = true;
        throw new Error("radio failed");
      }
    };

    expect(
      await call("naturalLight.followRoom", {
        placeId: "office",
        follow: true,
      }),
    ).toEqual({ failed: [{ device: "ceiling", capability: "light" }] });
    expect(following()).toEqual(["desk"]);
  });
});

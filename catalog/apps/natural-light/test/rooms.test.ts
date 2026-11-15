import { describe, expect, it, vi } from "vitest";

import { byHand, curveAt, minute, moods, off, on, running } from "./running.js";
import { zurich } from "./fake-core.js";

// Natural light's button for each room: White while every light in the room
// that is on follows the curve, a press then switching the room off, and
// otherwise a press bringing the room to natural light, with the lights
// that can't follow it off.

const stripFeatures = {
  brightness: true,
  colorTemperature: null,
  color: false,
};

function home() {
  const run = running();
  const { core } = run;
  core.addLight("ceiling", "Ceiling", { ...on, colorTemperature: 153 });
  core.addLight("desk", "Desk lamp", { ...off, colorTemperature: 153 });
  core.addLight("strip", "Shelf strip", { on: false }, stripFeatures);
  core.addLight("hall", "Hall light", { ...on, colorTemperature: 153 });
  const rooms: Record<string, string> = {
    ceiling: "office",
    desk: "office",
    strip: "office",
    hall: "hall",
  };
  for (const device of core.state.devices) device.roomId = rooms[device.id]!;
  const button = (room: string) =>
    core.state.entities.get(`room:${room}`)?.state as
      { active: boolean } | undefined;
  return { ...run, button };
}

describe("a room's button", () => {
  it("shows for each room where a light follows, White while every light that's on is on the curve", async () => {
    const { call, check, button } = home();
    await call("naturalLight.follow", {
      device: "hall",
      capability: "light",
      follow: false,
    });

    await check();

    expect(button("office")).toEqual({
      placeId: "office",
      icon: "sun",
      name: "Natural light",
      order: 0,
      active: true,
      input: { placeId: "office" },
    });
    expect(button("hall")).toBeUndefined();
  });

  it("turns grey at once when a mood sets a light that's on, or a light that can't follow comes on", async () => {
    const { app, core, check, button } = home();
    await app.start!(core.ctx, { reason: "started" });
    await check();
    expect(button("office")?.active).toBe(true);

    core.set("ceiling", { colorTemperature: 300, brightness: 40 }, moods);
    await core.changed("ceiling");

    await vi.waitFor(() => expect(button("office")?.active).toBe(false));
    expect(core.state.entities.get("ceiling/light")?.state).toMatchObject({
      status: "paused",
    });
    await app.stop!(core.ctx, { reason: "shutdown" });
  });

  it("is grey while a light that can't follow is on", async () => {
    const { core, check, button } = home();
    core.set("strip", { on: true }, byHand);

    await check();

    expect(button("office")?.active).toBe(false);
  });

  it("switches every light in the room off when pressed while White", async () => {
    const { core, call, check, button } = home();
    core.set("desk", { on: true }, byHand);
    await check();
    expect(button("office")?.active).toBe(true);
    const sent = core.state.sent.length;

    expect(
      await call("naturalLight.toggleRoom", { placeId: "office" }),
    ).toEqual({ failed: [] });

    expect(
      core.state.sent
        .slice(sent)
        .map(({ device, command }) => [device, command]),
    ).toEqual([
      ["ceiling", { on: false }],
      ["desk", { on: false }],
    ]);
    expect(button("office")?.active).toBe(false);
  });

  it("brings the room to natural light when pressed while grey, the lights that can't follow off", async () => {
    const { core, call, check, now, button } = home();
    await check();
    core.set("ceiling", { colorTemperature: 300, brightness: 40 }, moods);
    core.set("strip", { on: true }, byHand);
    const sent = core.state.sent.length;

    await call("naturalLight.toggleRoom", { placeId: "office" });

    expect(
      core.state.sent
        .slice(sent)
        .map(({ device, command }) => [device, command]),
    ).toEqual([
      ["ceiling", { on: true, ...curveAt(now()) }],
      ["desk", { on: true, ...curveAt(now()) }],
      ["strip", { on: false }],
    ]);
    expect(core.state.entities.get("ceiling/light")?.state).toMatchObject({
      status: "following",
    });
    expect(button("office")?.active).toBe(true);
  });

  it("brings a room to natural light from an automation, even while White", async () => {
    const { core, call, check, now } = home();
    await check();
    const sent = core.state.sent.length;

    await call("naturalLight.bringRoom", { placeId: "office" });

    expect(
      core.state.sent
        .slice(sent)
        .map(({ device, command }) => [device, command]),
    ).toEqual([
      ["ceiling", { on: true, ...curveAt(now()) }],
      ["desk", { on: true, ...curveAt(now()) }],
    ]);
  });

  it("names a light a press couldn't reach, and sets the others", async () => {
    const { core, call, check } = home();
    await check();
    core.set("ceiling", { colorTemperature: 300, brightness: 40 }, moods);
    let refused = false;
    core.state.beforeCommand = async () => {
      if (!refused) {
        refused = true;
        throw new Error("radio failed");
      }
    };

    expect(
      await call("naturalLight.toggleRoom", { placeId: "office" }),
    ).toEqual({ failed: [{ device: "ceiling", capability: "light" }] });
    expect(core.light("desk").state).toMatchObject({ on: true });
  });

  it("goes once no light in the room follows", async () => {
    const { call, check, button } = home();
    await check();

    await call("naturalLight.followRoom", { placeId: "office", follow: false });

    expect(button("office")).toBeUndefined();
  });

  it("goes while natural light is off, and comes back once it's on", async () => {
    const { app, core, call, check, button } = home();
    await app.start!(core.ctx, { reason: "started" });
    await check();

    await core.changeSettings({ on: false });
    await vi.waitFor(() => expect(button("office")).toBeUndefined());
    await expect(
      call("naturalLight.bringRoom", { placeId: "office" }),
    ).rejects.toThrow("Natural light is switched off");

    await core.changeSettings({ on: true });
    await vi.waitFor(() => expect(button("office")).toBeDefined());
    await app.stop!(core.ctx, { reason: "shutdown" });
  });

  it("waits for the home's location", async () => {
    const { core, check, advance, button } = home();
    core.state.location = null;

    await check();
    expect(button("office")).toBeUndefined();

    core.state.location = zurich;
    advance(5 * minute);
    await check();
    expect(button("office")).toBeDefined();
  });
});

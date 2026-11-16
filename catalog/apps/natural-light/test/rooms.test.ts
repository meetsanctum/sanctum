import { describe, expect, it, vi } from "vitest";

import { byHand, curveAt, moods, off, on, running } from "./running.js";
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

  it("turns grey when a light that can't follow joins the room while on", async () => {
    const { app, core, check, button } = home();
    await app.start!(core.ctx, { reason: "started" });
    try {
      await check();
      expect(button("office")?.active).toBe(true);

      await core.joins(
        "new-strip",
        "New strip",
        { on: true },
        {
          features: stripFeatures,
          roomId: "office",
        },
      );

      await vi.waitFor(() => expect(button("office")?.active).toBe(false));
    } finally {
      await app.stop!(core.ctx, { reason: "shutdown" });
    }
  });

  it("removes a departed light's target and its room's button at once", async () => {
    const { app, core, check, button } = home();
    await app.start!(core.ctx, { reason: "started" });
    try {
      await check();
      expect(button("hall")).toBeDefined();
      expect(core.state.entities.has("hall/light")).toBe(true);

      await core.removes("hall");

      await vi.waitFor(() => {
        expect(button("hall")).toBeUndefined();
        expect(core.state.entities.has("hall/light")).toBe(false);
      });
    } finally {
      await app.stop!(core.ctx, { reason: "shutdown" });
    }
  });

  it.each(["off", "no location"])(
    "refuses a stale White button press with %s",
    async (reason) => {
      const { core, call, check, button } = home();
      await check();
      expect(button("office")?.active).toBe(true);
      if (reason === "off") core.state.settings = { on: false };
      else core.state.location = null;
      const sent = core.state.sent.length;

      await expect(
        call("naturalLight.toggleRoom", { placeId: "office" }),
      ).rejects.toThrow(
        reason === "off"
          ? "Natural light is switched off"
          : "Natural light waits for the home's location",
      );

      expect(core.state.sent).toHaveLength(sent);
    },
  );

  it("keeps buttons hidden if natural light is switched off during a check", async () => {
    const { core, check, button } = home();
    await check();
    core.set("ceiling", { on: false }, byHand);
    core.press("ceiling", { colorTemperature: 400 });
    core.state.beforeCommand = async () => {
      core.state.settings = { on: false };
    };

    await check();

    expect(button("office")).toBeUndefined();
    expect(button("hall")).toBeUndefined();
  });

  it("waits for the next check after a failed command restores the same device state", async () => {
    const { app, core, check, advance } = home();
    await app.start!(core.ctx, { reason: "started" });
    try {
      await check();
      core.set("ceiling", { on: true }, byHand);
      core.press("ceiling", { colorTemperature: 400 });
      let attempts = 0;
      core.state.beforeCommand = async (device) => {
        if (device !== "ceiling") return;
        attempts += 1;
        // A failed delivery restores the preceding state and emits a
        // change. Bound the announcements so a retry loop can finish.
        if (attempts < 4) await core.changed("ceiling");
        throw new Error("radio failed");
      };

      await core.changed("ceiling");
      await vi.waitFor(() => expect(attempts).toBeGreaterThan(0));
      await new Promise((done) => setTimeout(done, 20));
      expect(attempts).toBe(1);

      advance(5 * 60_000);
      await check();
      expect(attempts).toBe(2);
    } finally {
      await app.stop!(core.ctx, { reason: "shutdown" });
    }
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

  it("waits for the home's location, and shows once it is set", async () => {
    const { app, core, check, button } = home();
    core.state.location = null;
    await app.start!(core.ctx, { reason: "started" });

    await check();
    expect(button("office")).toBeUndefined();

    await core.moves(zurich);
    await vi.waitFor(() => expect(button("office")).toBeDefined());
    expect(button("hall")).toBeDefined();
    await app.stop!(core.ctx, { reason: "shutdown" });
  });
});

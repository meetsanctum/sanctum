import { describe, expect, it, vi } from "vitest";

import { byHand, curveAt, minute, moods, off, on, running } from "./running.js";
import { publishButtons } from "../src/rooms.js";
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

  it("sends a press to every light in the room at once", async () => {
    const { core, call, check } = home();
    await check();
    core.set("ceiling", { colorTemperature: 300, brightness: 40 }, moods);
    core.set("strip", { on: true }, byHand);
    // No command is taken until the test lets them go.
    const waiting: string[] = [];
    let letGo = () => {};
    const held = new Promise<void>((resolve) => {
      letGo = resolve;
    });
    core.state.beforeCommand = async (device) => {
      waiting.push(device);
      await held;
    };

    const press = call("naturalLight.toggleRoom", { placeId: "office" });
    try {
      await vi.waitFor(() =>
        expect(waiting).toEqual(["ceiling", "desk", "strip"]),
      );
    } finally {
      letGo();
    }

    expect(await press).toEqual({ failed: [] });
  });

  it("follows the room's lights at once, while it is still setting each to the curve", async () => {
    const { app, core, check, button } = home();
    core.set("ceiling", { on: false }, byHand);
    await app.start!(core.ctx, { reason: "started" });
    try {
      await check();
      expect(button("office")?.active).toBe(false);
      // The lights come on as they were, and take no command meanwhile.
      let letGo = () => {};
      const held = new Promise<void>((resolve) => {
        letGo = resolve;
      });
      const asked: string[] = [];
      core.state.beforeCommand = async (device) => {
        asked.push(device);
        await held;
      };
      const sent = core.state.sent.length;

      core.set("ceiling", { on: true }, byHand);
      core.set("desk", { on: true }, byHand);
      core.press("ceiling", { colorTemperature: 400 });
      core.press("desk", { colorTemperature: 400 });
      await core.changed("ceiling");
      await core.changed("desk");

      try {
        await vi.waitFor(() => expect(asked).toEqual(["ceiling"]));
        await vi.waitFor(() => expect(button("office")?.active).toBe(true));
        expect(core.state.sent).toHaveLength(sent);

        // And grey again when they go off, the first still being set.
        core.set("ceiling", { on: false }, byHand);
        core.set("desk", { on: false }, byHand);
        await core.changed("ceiling");
        await core.changed("desk");
        await vi.waitFor(() => expect(button("office")?.active).toBe(false));
        expect(core.state.sent).toHaveLength(sent);
      } finally {
        letGo();
      }
      await vi.waitFor(() =>
        expect(core.state.sent.length).toBeGreaterThan(sent),
      );
    } finally {
      core.state.beforeCommand = null;
      await app.stop!(core.ctx, { reason: "shutdown" });
    }
  });

  it("stays White when a paused light answers again after being offline, which ends its pause", async () => {
    const { app, core, check, advance, button } = home();
    core.set("desk", { on: true }, byHand);
    await app.start!(core.ctx, { reason: "started" });
    try {
      await check();
      advance(minute);
      core.set("ceiling", { colorTemperature: 300, brightness: 40 }, moods);
      await core.changed("ceiling");
      await vi.waitFor(() =>
        expect(core.state.entities.get("ceiling/light")?.state).toMatchObject({
          status: "paused",
        }),
      );
      expect(button("office")?.active).toBe(false);
      const ceiling = core.state.devices.find((each) => each.id === "ceiling")!;
      ceiling.availability = "offline";
      await core.changed("ceiling", { availability: "online" });
      await vi.waitFor(() => expect(button("office")?.active).toBe(true));
      // Every state the button is published with from here on.
      const shown: boolean[] = [];
      const publish = core.state.entities.set.bind(core.state.entities);
      vi.spyOn(core.state.entities, "set").mockImplementation((key, entity) => {
        if (key === "room:office") {
          shown.push((entity.state as { active: boolean }).active);
        }
        return publish(key, entity);
      });

      advance(minute);
      ceiling.availability = "online";
      await core.changed("ceiling", { availability: "offline" });

      await vi.waitFor(() =>
        expect(core.state.entities.get("ceiling/light")?.state).toMatchObject({
          status: "following",
        }),
      );
      expect(shown).not.toContain(false);
      expect(button("office")?.active).toBe(true);
    } finally {
      await app.stop!(core.ctx, { reason: "shutdown" });
    }
  });

  it("stays White when a paused light comes back while its room's publication waits", async () => {
    const { app, core, check, advance, button } = home();
    core.set("desk", { on: true }, byHand);
    await app.start!(core.ctx, { reason: "started" });
    try {
      await check();
      advance(minute);
      core.set("ceiling", { colorTemperature: 300, brightness: 40 }, moods);
      await core.changed("ceiling");
      await vi.waitFor(() =>
        expect(core.state.entities.get("ceiling/light")?.state).toMatchObject({
          status: "paused",
        }),
      );
      const ceiling = core.state.devices.find((each) => each.id === "ceiling")!;
      ceiling.availability = "offline";
      await core.changed("ceiling", { availability: "online" });
      await vi.waitFor(() => expect(button("office")?.active).toBe(true));

      // A publication for the room that waits for the core's lights.
      let letGo = () => {};
      const held = new Promise<void>((resolve) => {
        letGo = resolve;
      });
      const list = core.ctx.devices.list.bind(core.ctx.devices);
      let isWaiting = false;
      const lists = vi
        .spyOn(core.ctx.devices, "list")
        .mockImplementation(async () => {
          isWaiting = true;
          await held;
          return list();
        });
      const shown: boolean[] = [];
      const publish = core.state.entities.set.bind(core.state.entities);
      vi.spyOn(core.state.entities, "set").mockImplementation((key, entity) => {
        if (key === "room:office") {
          shown.push((entity.state as { active: boolean }).active);
        }
        return publish(key, entity);
      });
      try {
        await core.changed("desk");
        await vi.waitFor(() => expect(isWaiting).toBe(true));

        // The paused light answers again before that publication goes on.
        advance(minute);
        ceiling.availability = "online";
        await core.changed("ceiling", { availability: "offline" });
      } finally {
        letGo();
        lists.mockRestore();
      }

      await vi.waitFor(() =>
        expect(core.state.entities.get("ceiling/light")?.state).toMatchObject({
          status: "following",
        }),
      );
      expect(shown).not.toContain(false);
      expect(button("office")?.active).toBe(true);
    } finally {
      await app.stop!(core.ctx, { reason: "shutdown" });
    }
  });

  it("leaves a room that waited as the lights were read, even once its wait ends while another room is published", async () => {
    const { core, check, button } = home();
    await check();
    expect(button("office")?.active).toBe(true);
    expect(button("hall")?.active).toBe(true);
    // The office's button has a change to publish, and the hall's light
    // reads as paused, as one back from offline does until it is followed.
    core.set("strip", { on: true }, byHand);
    core.set("hall", { colorTemperature: 300, brightness: 40 }, moods);
    let hallWaits = true;
    const published: string[] = [];
    const publish = core.state.entities.set.bind(core.state.entities);
    vi.spyOn(core.state.entities, "set").mockImplementation((key, entity) => {
      published.push(key);
      // Its wait ends while the office's button goes out.
      if (key === "room:office") hallWaits = false;
      return publish(key, entity);
    });

    await publishButtons(
      core.ctx,
      ["office", "hall"],
      (room) => room === "hall" && hallWaits,
    );

    expect(published).toEqual(["room:office"]);
    expect(button("office")?.active).toBe(false);
    expect(button("hall")?.active).toBe(true);
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

  it("comes with a rule for turning the room on: the lights that follow on, the others off", async () => {
    const { core, call, check } = home();
    await check();
    const rule = (room: string) =>
      core.state.entities.get(`turn-on:${room}`)?.state;

    expect(rule("office")).toEqual({
      placeId: "office",
      lights: [
        { device: "ceiling", capability: "light", state: { on: true } },
        { device: "desk", capability: "light", state: { on: true } },
        { device: "strip", capability: "light", state: { on: false } },
      ],
      until: null,
      rank: "look",
    });

    await call("naturalLight.follow", {
      device: "desk",
      capability: "light",
      follow: false,
    });
    expect(rule("office")).toMatchObject({
      lights: expect.arrayContaining([
        { device: "desk", capability: "light", state: { on: false } },
      ]),
    });

    await call("naturalLight.followRoom", { placeId: "office", follow: false });
    expect(rule("office")).toBeUndefined();
  });
});

import { describe, expect, it, vi } from "vitest";

import { zurich } from "./fake-core.js";

import {
  byHand,
  curveAt,
  lamp,
  minute,
  moods,
  on,
  running,
} from "./running.js";

// A light someone dims keeps following the day's colour at their
// brightness, until it is switched off and on; a mood or a colour still
// pauses it altogether. A light that answers again after being offline, as
// a bulb behind a wall switch does, counts as switched off and on.

async function dimmed() {
  const run = running();
  const { core, call, check, advance } = run;
  core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
  await call("naturalLight.follow", { ...lamp, follow: true });
  // Only what is set after it began following counts.
  advance(minute);
  core.set("lamp", { brightness: 40 }, byHand);
  await check();
  return run;
}

describe("dimming a light that follows", () => {
  it("keeps an explicit pause made after a switch whose change is still waiting", async () => {
    const { app, core, call, advance, target } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    await call("naturalLight.follow", { ...lamp, follow: true });
    await app.start!(core.ctx, { reason: "started" });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const read = core.ctx.devices.state.bind(core.ctx.devices);
    let isReading = false;
    const state = vi
      .spyOn(core.ctx.devices, "state")
      .mockImplementation(async (id) => {
        isReading = true;
        await waiting;
        return read(id);
      });
    const publication = vi.spyOn(core.ctx.entities, "publish");
    try {
      advance(minute);
      core.set("lamp", { on: false }, byHand);
      await core.changed("lamp");
      await vi.waitFor(() => expect(isReading).toBe(true));
      const before = structuredClone(core.state.devices[0]!);
      advance(minute);
      core.set("lamp", { brightness: 30 }, byHand);
      await core.changed("lamp", before);
      advance(minute);
      await call("naturalLight.pause", lamp);

      release();

      await vi.waitFor(() =>
        expect(publication).toHaveBeenCalledWith(
          expect.objectContaining({
            key: "lamp/light",
            state: expect.objectContaining({ status: "paused" }),
          }),
        ),
      );
      expect(target()).toMatchObject({ status: "paused" });
    } finally {
      release();
      state.mockRestore();
      publication.mockRestore();
      await app.stop!(core.ctx, { reason: "shutdown" });
    }
  });

  it("keeps a chosen colour paused while the home waits for its location", async () => {
    const { core, call, check, advance, target } = running();
    core.state.location = null;
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    await call("naturalLight.follow", { ...lamp, follow: true });
    advance(minute);
    core.set("lamp", { colorTemperature: 300, brightness: 60 }, moods);
    await check();
    advance(minute);
    core.set("lamp", { brightness: 30 }, byHand);
    await check();

    core.state.location = zurich;
    await check();

    expect(target()).toMatchObject({ status: "paused" });
    expect(core.light("lamp").state).toMatchObject({ colorTemperature: 300 });
  });

  it("keeps a colour pause when a brightness change arrives before the colour is read", async () => {
    const { app, core, call, advance, target } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    await call("naturalLight.follow", { ...lamp, follow: true });
    await app.start!(core.ctx, { reason: "started" });
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const read = core.ctx.devices.state.bind(core.ctx.devices);
    let isReading = false;
    const state = vi
      .spyOn(core.ctx.devices, "state")
      .mockImplementation(async (id) => {
        isReading = true;
        await waiting;
        return read(id);
      });
    try {
      advance(minute);
      core.set("lamp", { colorTemperature: 300, brightness: 60 }, moods);
      await core.changed("lamp");
      await vi.waitFor(() => expect(isReading).toBe(true));
      advance(minute);
      const before = structuredClone(core.state.devices[0]!);
      core.set("lamp", { brightness: 30 }, byHand);
      await core.changed("lamp", before);

      release();

      await vi.waitFor(() =>
        expect(target()).toMatchObject({ status: "paused" }),
      );
      expect(core.light("lamp").state).toMatchObject({ colorTemperature: 300 });
    } finally {
      release();
      state.mockRestore();
      await app.stop!(core.ctx, { reason: "shutdown" });
    }
  });

  it("keeps a chosen brightness even when it equals the curve at the time", async () => {
    const { core, call, check, advance, target } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    await call("naturalLight.follow", { ...lamp, follow: true });
    const brightness = core.light("lamp").state!.brightness;
    advance(minute);

    core.set("lamp", { brightness }, byHand);
    await check();

    expect(target()).toMatchObject({ status: "dimmed", brightness: null });
    advance(8 * 60 * minute);
    await check();
    expect(core.light("lamp").state).toMatchObject({ brightness });
  });

  it("keeps its colour on the curve at the brightness someone chose, check after check", async () => {
    const { core, check, advance, now, sentFrom, target } = await dimmed();
    expect(target()).toMatchObject({ status: "dimmed", brightness: null });
    const sent = core.state.sent.length;

    advance(30 * minute);
    await check();
    advance(30 * minute);
    await check();

    // Its colour as the curve moves, never its brightness, though natural
    // light's own colour is what last set it.
    expect(sentFrom(sent)).toEqual([
      {
        colorTemperature: curveAt(new Date(now().getTime() - 30 * minute))
          .colorTemperature,
      },
      { colorTemperature: curveAt(now()).colorTemperature },
    ]);
    expect(core.light("lamp").state).toMatchObject({ brightness: 40 });
    expect(target()).toMatchObject({ status: "dimmed" });
  });

  it("brings back the curve's brightness once it is switched off and on", async () => {
    const { core, check, now, sentFrom, target } = await dimmed();
    const sent = core.state.sent.length;

    core.set("lamp", { on: false }, byHand);
    await check();

    expect(sentFrom(sent)).toEqual([{ on: false, ...curveAt(now()) }]);
    expect(target()).toMatchObject({ status: "following" });
  });

  it("brings back the curve's brightness on Resume", async () => {
    const { core, call, now, sentFrom, target } = await dimmed();
    core.set("lamp", { brightness: 40, colorTemperature: 300 }, byHand);
    core.set("lamp", { brightness: 40 }, byHand);
    const sent = core.state.sent.length;

    await call("naturalLight.resume", lamp);

    expect(sentFrom(sent)).toEqual([curveAt(now())]);
    expect(target()).toMatchObject({ status: "following" });
  });

  it("is paused altogether by a mood", async () => {
    const { core, check, target } = await dimmed();

    core.set("lamp", { colorTemperature: 300, brightness: 60 }, moods);
    await check();

    expect(target()).toMatchObject({ status: "paused" });
  });

  it("keeps a mood's colour paused when its brightness is changed afterwards", async () => {
    const { core, check, advance, target, sentFrom } = await dimmed();
    advance(minute);
    core.set("lamp", { colorTemperature: 300, brightness: 60 }, moods);
    await check();
    const sent = core.state.sent.length;
    advance(minute);

    core.set("lamp", { brightness: 30 }, byHand);
    await check();

    expect(target()).toMatchObject({ status: "paused" });
    expect(sentFrom(sent)).toEqual([]);
    expect(core.light("lamp").state).toMatchObject({
      colorTemperature: 300,
      brightness: 30,
    });
  });

  it("keeps its room's tile from being lit, and a press brings the curve's brightness back", async () => {
    const { core, call, check, now, sentFrom, target } = await dimmed();
    core.state.devices[0]!.roomId = "office";
    await check();
    const button = () =>
      core.state.entities.get("room:office")?.state as { active: boolean };
    expect(button().active).toBe(false);
    const sent = core.state.sent.length;

    await call("naturalLight.bringRoom", { placeId: "office" });

    expect(sentFrom(sent)).toEqual([{ on: true, ...curveAt(now()) }]);
    expect(target()).toMatchObject({ status: "following" });
    expect(button().active).toBe(true);
  });
});

describe("a light that answers again after being offline", () => {
  it("still restores a device's other lights when its first light cannot be set", async () => {
    const { app, core, check, advance, now } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    const second = structuredClone(core.light("lamp"));
    second.id = "second";
    core.state.devices[0]!.capabilities.push(second);
    await check();
    await app.start!(core.ctx, { reason: "started" });
    try {
      advance(minute);
      core.press("lamp", { colorTemperature: 153 });
      second.state = { ...on, colorTemperature: 153 };
      let attempts = 0;
      core.state.beforeCommand = async () => {
        if (++attempts === 1) throw new Error("radio failed");
      };

      await core.changed("lamp", { availability: "offline" });

      await vi.waitFor(() =>
        expect(second.state).toMatchObject(curveAt(now())),
      );
      expect(attempts).toBe(2);
    } finally {
      await app.stop!(core.ctx, { reason: "shutdown" });
    }
  });

  it("ends a pause even when it answers with the same state as before", async () => {
    const { app, core, call, advance, now, sentFrom, target } = running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    await call("naturalLight.follow", { ...lamp, follow: true });
    await app.start!(core.ctx, { reason: "started" });
    try {
      advance(minute);
      core.set("lamp", { colorTemperature: 300, brightness: 40 }, moods);
      await core.changed("lamp");
      await vi.waitFor(() =>
        expect(target()).toMatchObject({ status: "paused" }),
      );
      const sent = core.state.sent.length;

      await core.changed("lamp", { availability: "offline" });

      await vi.waitFor(() => expect(sentFrom(sent)).toEqual([curveAt(now())]));
      expect(target()).toMatchObject({ status: "following" });
    } finally {
      await app.stop!(core.ctx, { reason: "shutdown" });
    }
  });

  it.each(["colour", "brightness", "pause"] as const)(
    "keeps a later %s choice while its recovery waits to be read",
    async (choice) => {
      const { app, core, call, advance, now, target, sentFrom } = running();
      core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
      await call("naturalLight.follow", { ...lamp, follow: true });
      await app.start!(core.ctx, { reason: "started" });
      let release!: () => void;
      const waiting = new Promise<void>((resolve) => (release = resolve));
      const read = core.ctx.devices.state.bind(core.ctx.devices);
      let isReading = false;
      const state = vi
        .spyOn(core.ctx.devices, "state")
        .mockImplementation(async (id) => {
          isReading = true;
          await waiting;
          return read(id);
        });
      const publication = vi.spyOn(core.ctx.entities, "publish");
      try {
        advance(minute);
        core.press("lamp", { colorTemperature: 153 });
        await core.changed("lamp", { availability: "offline" });
        await vi.waitFor(() => expect(isReading).toBe(true));
        const sent = core.state.sent.length;
        advance(minute);
        if (choice === "colour") {
          core.set("lamp", { colorTemperature: 300, brightness: 40 }, moods);
        } else if (choice === "brightness") {
          core.set("lamp", { brightness: 40 }, byHand);
        } else {
          await call("naturalLight.pause", lamp);
        }

        release();

        const status = choice === "brightness" ? "dimmed" : "paused";
        await vi.waitFor(() =>
          expect(publication).toHaveBeenCalledWith(
            expect.objectContaining({
              key: "lamp/light",
              state: expect.objectContaining({ status }),
            }),
          ),
        );
        expect(target()).toMatchObject({ status });
        expect(sentFrom(sent)).toEqual(
          choice === "brightness"
            ? [{ colorTemperature: curveAt(now()).colorTemperature }]
            : [],
        );
        if (choice === "brightness") {
          expect(core.light("lamp").state).toMatchObject({ brightness: 40 });
        }
      } finally {
        release();
        state.mockRestore();
        publication.mockRestore();
        await app.stop!(core.ctx, { reason: "shutdown" });
      }
    },
  );

  it("takes the curve at once, as if switched off and on, its pause ended", async () => {
    const { app, core, call, check, advance, now, sentFrom, target } =
      running();
    core.addLight("lamp", "Office light", { ...on, colorTemperature: 153 });
    await call("naturalLight.follow", { ...lamp, follow: true });
    await app.start!(core.ctx, { reason: "started" });
    advance(minute);
    core.set("lamp", { colorTemperature: 300, brightness: 40 }, moods);
    await check();
    expect(target()).toMatchObject({ status: "paused" });
    // The power comes back at the wall: the bulb's own default.
    core.press("lamp", { on: true, brightness: 100, colorTemperature: 153 });
    const sent = core.state.sent.length;

    await core.changed("lamp", { availability: "offline" });

    await vi.waitFor(() => expect(sentFrom(sent)).toEqual([curveAt(now())]));
    expect(target()).toMatchObject({ status: "following" });
    await app.stop!(core.ctx, { reason: "shutdown" });
  });
});

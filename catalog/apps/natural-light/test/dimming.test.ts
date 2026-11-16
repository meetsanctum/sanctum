import { describe, expect, it, vi } from "vitest";

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

  it("turns its room's button grey, and a press brings the curve's brightness back", async () => {
    const { core, call, check, now, sentFrom, target } = await dimmed();
    core.state.devices[0]!.roomId = "office";
    await check();
    const button = () =>
      core.state.entities.get("room:office")?.state as { active: boolean };
    expect(button().active).toBe(false);
    const sent = core.state.sent.length;

    await call("naturalLight.toggleRoom", { placeId: "office" });

    expect(sentFrom(sent)).toEqual([{ on: true, ...curveAt(now()) }]);
    expect(target()).toMatchObject({ status: "following" });
    expect(button().active).toBe(true);
  });
});

describe("a light that answers again after being offline", () => {
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

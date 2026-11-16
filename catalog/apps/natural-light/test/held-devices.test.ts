import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import { publishButtons } from "../src/rooms.js";
import { moods, off, on, running } from "./running.js";

// A room's lights each change several times as the room is switched, and
// nearly every such change leaves the room's button as it is. Natural light
// holds the devices as their events leave them and asks the core for a
// room's lights only where those say its button may have changed; what it
// publishes is always what the core then says.

function home() {
  const run = running();
  const { core } = run;
  core.addLight("ceiling", "Ceiling", { ...on, colorTemperature: 153 });
  core.addLight("desk", "Desk lamp", { ...off, colorTemperature: 153 });
  for (const device of core.state.devices) device.roomId = "office";
  const button = () =>
    core.state.entities.get("room:office")?.state as
      { active: boolean } | undefined;
  // The core's own answer, and how often the app read every device from it.
  const list = core.ctx.devices.list.bind(core.ctx.devices);
  const lists = vi.spyOn(core.ctx.devices, "list");
  // The room's button, each time it went out.
  const shown: boolean[] = [];
  const publish = core.state.entities.set.bind(core.state.entities);
  vi.spyOn(core.state.entities, "set").mockImplementation((key, entity) => {
    if (key === "room:office") {
      shown.push((entity.state as { active: boolean }).active);
    }
    return publish(key, entity);
  });
  // The devices as the core has them now, as a caller that held them would.
  const held = () => structuredClone(core.state.devices) as DeviceInfo[];
  return { ...run, button, list, lists, shown, held };
}

describe("a room's button, with the devices held", () => {
  it("asks the core for nothing while they leave it as it is", async () => {
    const { core, check, button, lists, shown, held } = home();
    await check();
    expect(button()?.active).toBe(true);
    lists.mockClear();
    shown.length = 0;

    await publishButtons(core.ctx, ["office"], undefined, held);

    expect(lists).not.toHaveBeenCalled();
    expect(shown).toEqual([]);
  });

  it("reads the lights from the core once they say it changed, and publishes that", async () => {
    const { core, check, button, lists, shown, held } = home();
    await check();
    // A mood has set the ceiling, which turns the button grey.
    core.set("ceiling", { colorTemperature: 300, brightness: 40 }, moods);
    lists.mockClear();
    shown.length = 0;

    await publishButtons(core.ctx, ["office"], undefined, held);

    expect(lists).toHaveBeenCalledTimes(1);
    expect(shown).toEqual([false]);
    expect(button()?.active).toBe(false);
  });

  it("publishes what the core says, not what is held", async () => {
    const { core, check, button, lists, shown, held } = home();
    await check();
    const ceiling = core.state.devices.find((each) => each.id === "ceiling")!;
    const onTheCurve = structuredClone(ceiling.capabilities);
    // Held: a mood has set the ceiling, which would turn the button grey.
    core.set("ceiling", { colorTemperature: 300, brightness: 40 }, moods);
    const asHeld = held();
    // The core: back on the curve by the time it is asked.
    ceiling.capabilities = onTheCurve;
    lists.mockClear();
    shown.length = 0;

    await publishButtons(core.ctx, ["office"], undefined, () => asHeld);

    expect(lists).toHaveBeenCalledTimes(1);
    expect(shown).toEqual([]);
    expect(button()?.active).toBe(true);
  });

  it("asks the core as ever where no devices are held", async () => {
    const { core, check, lists, shown } = home();
    await check();
    lists.mockClear();
    shown.length = 0;

    await publishButtons(core.ctx, ["office"], undefined, () => null);

    expect(lists).toHaveBeenCalledTimes(1);
    expect(shown).toEqual([]);
  });
});

describe("natural light, running", () => {
  // Starts the app, checks once, and counts the lists from then on.
  async function started() {
    const context = home();
    const { app, core, check, lists, shown } = context;
    await app.start!(core.ctx, { reason: "started" });
    await check();
    lists.mockClear();
    shown.length = 0;
    return context;
  }

  // Lets the app's loops take what they have heard: the lists stop growing.
  async function followed(lists: { mock: { calls: unknown[] } }) {
    let seen = -1;
    await vi.waitFor(() => {
      const now = lists.mock.calls.length;
      const isSettled = now === seen;
      seen = now;
      expect(isSettled).toBe(true);
    });
  }

  it("reads the lights once, for the room's rules, when a light's change leaves the button as it is", async () => {
    const { app, core, button, lists, shown } = await started();
    try {
      // The ceiling reports again what it showed.
      await core.changed("ceiling");
      await followed(lists);

      expect(lists).toHaveBeenCalledTimes(1);
      expect(shown).toEqual([]);
      expect(button()?.active).toBe(true);
    } finally {
      await app.stop!(core.ctx, { reason: "shutdown" });
    }
  });

  it("still turns the button grey when a light's change does", async () => {
    const { app, core, button, shown } = await started();
    try {
      core.set("ceiling", { colorTemperature: 300, brightness: 40 }, moods);
      await core.changed("ceiling");

      await vi.waitFor(() => expect(button()?.active).toBe(false));
      expect(shown).toEqual([false]);
    } finally {
      await app.stop!(core.ctx, { reason: "shutdown" });
    }
  });

  it("holds a light that joins, and lets go of one that leaves", async () => {
    const { app, core, button, lists } = await started();
    try {
      // A light that can't follow joins the room on: the button turns grey.
      await core.joins(
        "strip",
        "Shelf strip",
        { on: true },
        {
          features: { brightness: true, colorTemperature: null, color: false },
          roomId: "office",
        },
      );
      await vi.waitFor(() => expect(button()?.active).toBe(false));
      // Held, the strip keeps the button grey as recorded, so the ceiling's
      // next report asks nothing for the button.
      await followed(lists);
      lists.mockClear();
      await core.changed("ceiling");
      await followed(lists);
      expect(lists).toHaveBeenCalledTimes(1);
      // It leaves again: White, and the ceiling's next report asks nothing
      // for the button either, as the strip is held no longer.
      await core.removes("strip");
      await vi.waitFor(() => expect(button()?.active).toBe(true));
      await followed(lists);
      lists.mockClear();

      await core.changed("ceiling");
      await followed(lists);

      expect(lists).toHaveBeenCalledTimes(1);
    } finally {
      await app.stop!(core.ctx, { reason: "shutdown" });
    }
  });

  it("holds the devices anew when the core has restarted", async () => {
    const { app, core, button, lists } = await started();
    try {
      // While the core was away a light that can't follow, held as on, left
      // the home, which no event says.
      await core.joins(
        "strip",
        "Shelf strip",
        { on: true },
        {
          features: { brightness: true, colorTemperature: null, color: false },
          roomId: "office",
        },
      );
      await vi.waitFor(() => expect(button()?.active).toBe(false));
      core.state.devices.splice(
        core.state.devices.findIndex((each) => each.id === "strip"),
        1,
      );

      await app.resume!(core.ctx, { reason: "started" });
      expect(button()?.active).toBe(true);
      await followed(lists);
      lists.mockClear();
      await core.changed("ceiling");
      await followed(lists);

      // Held still, the strip would have had the button's lights read too.
      expect(lists).toHaveBeenCalledTimes(1);
    } finally {
      await app.stop!(core.ctx, { reason: "shutdown" });
    }
  });

  it("reads the lights for the button too while it could not read the devices to hold", async () => {
    const context = home();
    const { app, core, check, list, lists } = context;
    // The devices are read to be held right after the lights are taken in.
    let reads = 0;
    lists.mockImplementation(async () => {
      reads += 1;
      if (reads === 2) throw new Error("the core is busy");
      return list();
    });
    await app.start!(core.ctx, { reason: "started" });
    try {
      expect(core.state.logs).toContainEqual(
        expect.stringContaining("could not read the devices to hold"),
      );
      await check();
      lists.mockClear();

      await core.changed("ceiling");
      await followed(lists);

      expect(lists).toHaveBeenCalledTimes(2);
    } finally {
      await app.stop!(core.ctx, { reason: "shutdown" });
    }
  });
});

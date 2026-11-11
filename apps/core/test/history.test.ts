import { describe, expect, it } from "vitest";

import {
  command,
  lampsCore,
  personWithClient,
  radio,
  settled,
} from "./devices-support.js";
import { get, post, sharedClient, testCore, type TestCore } from "./support.js";

// History, ported from v1's recorder: each change of what a device reported, or
// of whether it answered, and its roll-ups every 5 minutes and every hour, for
// whoever may see the device.

const minute = 60_000;
const lampOff = {
  on: false,
  brightness: 100,
  colorMode: "temperature",
  colorTemperature: 370,
};

function states(
  core: TestCore,
  token: string,
  device: string,
  query: Record<string, string> = {},
  capability = "light",
) {
  const params = new URLSearchParams({ device, capability, ...query });
  return get(core, `/api/history/states?${params}`, { token });
}

function statistics(
  core: TestCore,
  token: string,
  device: string,
  query: Record<string, string>,
  capability = "light",
) {
  const params = new URLSearchParams({ device, capability, ...query });
  return get(core, `/api/history/statistics?${params}`, { token });
}

// Lets what was set off settle, as a light confirming a command, then
// moves the core's clock on.
async function later(core: TestCore, ms: number) {
  await settled();
  core.advance(ms);
}

describe("history", () => {
  it("waits for queued changes to be written before rolling up their periods", async () => {
    const { core, maya, lamp } = await lampsCore();
    const noon = core.now().getTime();
    await later(core, 2 * minute);
    await command(core, maya.token, lamp, "light", { on: true });
    await later(core, 3 * minute);
    core.db.$client.exec(`
      create temp trigger fail_history_write before insert on history_states
      begin select raise(abort, 'write failed'); end;
    `);
    core.history.maintain();
    expect(core.logs.some((line) => line.includes("write failed"))).toBe(true);
    core.db.$client.exec("drop trigger fail_history_write");
    core.history.maintain();

    const answer = (
      await statistics(core, maya.token, lamp, {
        from: new Date(noon).toISOString(),
        period: "5m",
      })
    ).json();
    expect(answer.fields.on).toEqual([
      {
        start: new Date(noon).toISOString(),
        mean: 3 / 5,
        min: 0,
        max: 1,
        seconds: 300,
      },
    ]);
  });

  it.each(["removed", "changed"])(
    "forgets a capability whose kind is %s, including queued changes",
    async (change) => {
      const { core, maya, lamp } = await lampsCore();
      await later(core, minute);
      await command(core, maya.token, lamp, "light", { on: true });
      await settled();
      core.devices.register("test.lamps", {
        key: "lamp-1",
        name: "Kitchen lamp",
        capabilities: [
          { id: change === "removed" ? "power" : "light", kind: "switch" },
        ],
      });
      await later(core, 60 * minute);
      core.history.maintain();
      expect(
        core.db.$client
          .prepare(
            "select count(*) as count from history_series where device_id = ?",
          )
          .get(lamp),
      ).toEqual({ count: 0 });

      // Reusing the old id and kind must not revive its old state.
      core.devices.register("test.lamps", {
        key: "lamp-1",
        name: "Kitchen lamp",
        capabilities: [
          { id: "light", kind: "light", features: { brightness: true } },
        ],
      });
      expect((await states(core, maya.token, lamp)).json().states).toEqual([]);
    },
  );

  it("records each change of a light, with what it was before the range", async () => {
    const { core, maya, lamp } = await lampsCore();
    const started = core.now().toISOString();

    await later(core, minute);
    await command(core, maya.token, lamp, "light", {
      on: true,
      brightness: 40,
    });
    await settled();
    await later(core, minute);
    await radio.press("lamp-1", { on: false });
    await settled();

    const answer = await states(core, maya.token, lamp, {
      from: new Date(Date.parse(started) + 30_000).toISOString(),
    });
    expect(answer.statusCode).toBe(200);
    expect(answer.json()).toEqual({
      device: lamp,
      capability: "light",
      kind: "light",
      from: new Date(Date.parse(started) + 30_000).toISOString(),
      to: core.now().toISOString(),
      kept: true,
      states: [
        { at: started, availability: "online", state: lampOff },
        {
          at: new Date(Date.parse(started) + minute).toISOString(),
          availability: "online",
          state: { ...lampOff, on: true, brightness: 40 },
        },
        {
          at: core.now().toISOString(),
          availability: "online",
          state: { ...lampOff, brightness: 40 },
        },
      ],
    });
  });

  it("records nothing for a report that changes nothing, or a command not yet confirmed", async () => {
    const { core, maya, lamp } = await lampsCore();

    await later(core, minute);
    await radio.press("lamp-1", {});
    radio.confirms = false;
    await command(core, maya.token, lamp, "light", { on: true });
    await settled();

    const recorded = (await states(core, maya.token, lamp)).json().states;
    expect(recorded).toHaveLength(1);
    expect(recorded[0].state).toEqual(lampOff);
  });

  it("records a device that stops answering, and a switch's on and off", async () => {
    const { core, maya, plug } = await lampsCore();

    await later(core, minute);
    await radio.press("plug-1", { on: true });
    await later(core, minute);
    await radio.unplug("plug-1");
    await settled();

    expect(
      (await states(core, maya.token, plug, {}, "power"))
        .json()
        .states.map((each: { availability: string; state: unknown }) => [
          each.availability,
          each.state,
        ]),
    ).toEqual([
      ["online", { on: false }],
      ["online", { on: true }],
      ["offline", { on: true }],
    ]);
  });

  it("rolls up every 5 minutes and every hour, weighed by time", async () => {
    // At 12:00 the lamp is off; from 12:02 it is on at 60%, from 12:32 at
    // 30%, and at 12:47 it goes off.
    const { core, maya, lamp } = await lampsCore();
    const noon = core.now().getTime();
    await later(core, 2 * minute);
    await command(core, maya.token, lamp, "light", {
      on: true,
      brightness: 60,
    });
    await later(core, 30 * minute);
    await command(core, maya.token, lamp, "light", { brightness: 30 });
    await later(core, 15 * minute);
    await command(core, maya.token, lamp, "light", { on: false });
    await later(core, 20 * minute);
    core.history.maintain();

    const range = {
      from: new Date(noon).toISOString(),
      to: new Date(noon + 60 * minute).toISOString(),
    };
    const fiveMinutes = (
      await statistics(core, maya.token, lamp, { ...range, period: "5m" })
    ).json();
    expect(fiveMinutes.fields.on).toHaveLength(12);
    expect(fiveMinutes.fields.on[0]).toEqual({
      start: range.from,
      mean: 3 / 5,
      min: 0,
      max: 1,
      seconds: 300,
    });
    expect(fiveMinutes.fields.brightness[0]).toEqual({
      start: range.from,
      mean: 60,
      min: 60,
      max: 60,
      seconds: 180,
    });
    // From 12:45: on at 30% for two minutes.
    expect(fiveMinutes.fields.on[9]).toMatchObject({ mean: 2 / 5 });
    expect(fiveMinutes.fields.brightness).toHaveLength(10);

    const hour = (
      await statistics(core, maya.token, lamp, { ...range, period: "hour" })
    ).json();
    expect(hour).toMatchObject({ period: "hour", kind: "light", kept: true });
    expect(hour.fields.on).toEqual([
      { start: range.from, mean: 45 / 60, min: 0, max: 1, seconds: 3600 },
    ]);
    expect(hour.fields.brightness).toEqual([
      {
        start: range.from,
        mean: (60 * 30 + 30 * 15) / 45,
        min: 30,
        max: 60,
        seconds: 45 * 60,
      },
    ]);
  });

  it("catches up on the roll-ups it missed, and keeps the last change before what it takes out", async () => {
    const { core, maya, lamp } = await lampsCore();
    const noon = core.now().getTime();
    await later(core, minute);
    await command(core, maya.token, lamp, "light", {
      on: true,
      brightness: 50,
    });
    await settled();

    // Eleven days on, nothing changed: the 10 days before are rolled up,
    // and the changes older than that are gone, but for the last one.
    await later(core, 11 * 24 * 60 * minute);
    core.history.maintain();

    const recorded = (await states(core, maya.token, lamp)).json().states;
    expect(recorded).toEqual([
      {
        at: new Date(noon + minute).toISOString(),
        availability: "online",
        state: { ...lampOff, on: true, brightness: 50 },
      },
    ]);
    const yesterday = (
      await statistics(core, maya.token, lamp, {
        from: new Date(noon + 10 * 24 * 60 * minute).toISOString(),
        to: new Date(noon + 11 * 24 * 60 * minute).toISOString(),
        period: "hour",
      })
    ).json();
    expect(yesterday.fields.on).toHaveLength(24);
    expect(
      yesterday.fields.brightness.every(
        (each: { mean: number }) => each.mean === 50,
      ),
    ).toBe(true);
  });

  it("knows nothing while the core is stopped, and what each device is once it starts", async () => {
    const { core, maya, lamp } = await lampsCore();
    const stopped = new Date(core.now().getTime() + minute);
    core.advance(minute);
    core.history.close();

    const next = await testCore({
      dataDir: core.dataDir,
      startsAt: new Date(stopped.getTime() + 10 * minute).toISOString(),
    });
    const recorded = (
      await states(next, maya.token, lamp, {
        from: new Date(stopped.getTime() - 5 * minute).toISOString(),
      })
    ).json().states;
    expect(recorded).toEqual([
      { at: expect.any(String), availability: "online", state: lampOff },
      { at: stopped.toISOString(), availability: "unknown", state: null },
      {
        at: next.now().toISOString(),
        availability: "online",
        state: lampOff,
      },
    ]);
  });

  it("is seen on every client, shared ones too", async () => {
    const { core, lamp } = await lampsCore();
    const kitchen = sharedClient(core);
    const ben = personWithClient(core);

    expect((await states(core, kitchen.token, lamp)).statusCode).toBe(200);
    expect(
      (await statistics(core, kitchen.token, lamp, { period: "hour" }))
        .statusCode,
    ).toBe(200);
    expect((await states(core, ben.token, lamp)).statusCode).toBe(200);
  });

  it("refuses what it does not record, an unknown device and ranges it does not keep", async () => {
    const { core, maya, lamp } = await lampsCore();
    await radio.add("remote-1", "button", "Remote");
    await settled();
    const remote = (await get(core, "/api/devices", { token: maya.token }))
      .json()
      .find((each: { driverName: string }) => each.driverName === "Remote").id;

    expect(
      (await states(core, maya.token, remote, {}, "button")).statusCode,
    ).toBe(404);
    expect((await states(core, maya.token, "no-such-device")).statusCode).toBe(
      404,
    );
    expect(
      (
        await states(core, maya.token, lamp, {
          from: new Date(
            core.now().getTime() - 11 * 24 * 60 * minute,
          ).toISOString(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await statistics(core, maya.token, lamp, {
          period: "5m",
          from: new Date(
            core.now().getTime() - 3 * 24 * 60 * minute,
          ).toISOString(),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (await statistics(core, maya.token, lamp, { period: "day" })).statusCode,
    ).toBe(400);
    expect((await states(core, "not-a-token", lamp)).statusCode).toBe(401);
  });

  it("lets anyone stop keeping a device's history, which deletes it, and keep it again", async () => {
    const { core, maya, lamp, plug } = await lampsCore();
    const ben = personWithClient(core);
    const kitchen = sharedClient(core);
    await later(core, minute);
    await command(core, maya.token, lamp, "light", { on: true });
    await settled();

    const forgotten = await post(
      core,
      "/api/history/keep",
      { device: lamp, kept: false },
      { token: kitchen.token },
    );
    expect(forgotten.json()).toEqual({ device: lamp, kept: false });
    await later(core, minute);
    await command(core, maya.token, lamp, "light", { on: false });
    await settled();
    expect((await states(core, maya.token, lamp)).json()).toMatchObject({
      kept: false,
      states: [],
    });
    expect(
      (await get(core, "/api/history/devices", { token: ben.token })).json(),
    ).toEqual(
      expect.arrayContaining([
        { device: lamp, kept: false },
        { device: plug, kept: true },
      ]),
    );

    await later(core, minute);
    await post(
      core,
      "/api/history/keep",
      { device: lamp, kept: true },
      { token: maya.token },
    );
    expect((await states(core, maya.token, lamp)).json()).toMatchObject({
      kept: true,
      states: [{ at: core.now().toISOString(), state: lampOff }],
    });
    expect(
      core.activity
        .recent()
        .filter((entry) => entry.source === "history")
        .map((entry) => [entry.action, entry.personId, entry.subjectId]),
    ).toEqual([
      ["history.keep", maya.person.id, lamp],
      ["history.forget", null, lamp],
    ]);
  });

  it("goes with its device", async () => {
    const { core, maya, lamp } = await lampsCore();
    await later(core, minute);
    await command(core, maya.token, lamp, "light", { on: true });
    await settled();
    core.history.maintain();

    await post(
      core,
      "/api/devices/remove",
      { id: lamp },
      { token: maya.token },
    );

    const left = core.db.$client
      .prepare(
        "select (select count(*) from history_series) + (select count(*) from history_states) + (select count(*) from history_devices) as rows",
      )
      .get() as { rows: number };
    // The kettle plug's series and its one state stay.
    expect(left.rows).toBe(2);
  });
});

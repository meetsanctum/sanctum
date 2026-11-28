import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { lampsCore, settled } from "./devices-support.js";
import { screens } from "./fixtures/apps/tvs/index.js";
import { loadAppPackage } from "./runner-apps.js";
import {
  deferredDelivery,
  fixtureApps,
  get,
  post,
  sharedClient,
  type TestCore,
} from "./support.js";

// Adding and repairing that ask once they have started, with the TVs driver:
// a TV shows a first code once pairing starts, then a second that lasts 35
// seconds. Each answer comes in a request of its own, naming the client's
// attempt and the step it answers.

afterEach(() => vi.useRealTimers());

async function tvsCore() {
  screens.reset();
  const tvs = await loadAppPackage(join(fixtureApps, "tvs"), "official");
  const home = await lampsCore({ apps: [tvs] });
  await screens.sayFound([{ key: "tv-1", name: "Living Room" }]);
  await settled();
  return home;
}

type Who = { token: string };

const add = (core: TestCore, who: Who, body: Record<string, unknown>) =>
  post(
    core,
    "/api/devices/add",
    { driver: "sanctum.example", key: "tv-1", ...body },
    who,
  );

const cancelAdd = (core: TestCore, who: Who, attempt: string) =>
  post(
    core,
    "/api/devices/add/cancel",
    { driver: "sanctum.example", key: "tv-1", attempt },
    who,
  );

function entries(core: TestCore, action: string) {
  return core.activity.recent().filter((entry) => entry.action === action);
}

describe("adding that asks", () => {
  it("lists what it asks once started, so a client knows the steps ahead", async () => {
    const { core, maya } = await tvsCore();
    const [tv] = (await get(core, "/api/devices/pairing", maya)).json().found;
    expect(tv).toMatchObject({
      key: "tv-1",
      asks: [],
      later: ["firstCode", "secondCode"],
    });
  });

  it("asks each code in a step of its own, then adds the TV", async () => {
    const { core, maya } = await tvsCore();
    const attempt = randomUUID();

    const first = (await add(core, maya, { attempt })).json();
    expect(first).toMatchObject({
      attempt,
      step: 1,
      asks: [{ id: "firstCode", kind: "code", length: 4, lasts: null }],
      withinMs: 180_000,
      lastsMs: null,
    });
    const second = (
      await add(core, maya, {
        attempt,
        step: 1,
        answers: { firstCode: "1234" },
      })
    ).json();
    expect(second).toMatchObject({
      step: 2,
      asks: [
        {
          id: "secondCode",
          lasts: { seconds: 35, again: "Show a new code" },
        },
      ],
      lastsMs: 35_000,
    });
    const done = await add(core, maya, {
      attempt,
      step: 2,
      answers: { secondCode: "0042" },
    });

    expect(done.json().added).toMatchObject({ driverName: "tv-1" });
    expect(screens.calls).toEqual([
      "add tv-1",
      "add tv-1 firstCode",
      "add tv-1 secondCode",
    ]);
    expect(screens.attempts).toEqual([attempt, attempt, attempt]);
    expect(entries(core, "device.add")).toMatchObject([{ outcome: "ok" }]);
    // No answer and no attempt reaches the log or the activity log.
    const said = JSON.stringify([core.logs, core.activity.recent()]);
    expect(said).not.toContain("0042");
    expect(said).not.toContain(attempt);
  });

  it("refuses a client that names no attempt before the driver hears of it", async () => {
    const { core, maya } = await tvsCore();

    const started = await add(core, maya, {});

    expect(started.json()).toEqual({ error: "invalid_request" });
    expect(screens.calls).toEqual([]);
  });

  it("asks again after a wrong code, and ends after five", async () => {
    const { core, maya } = await tvsCore();
    const attempt = randomUUID();
    await add(core, maya, { attempt });

    const wrong = (
      await add(core, maya, {
        attempt,
        step: 1,
        answers: { firstCode: "9999" },
      })
    ).json();
    expect(wrong).toMatchObject({
      step: 2,
      asks: [{ id: "firstCode" }],
      refused: { question: "firstCode", refusal: "wrongCode" },
    });
    for (const step of [2, 3, 4]) {
      await add(core, maya, { attempt, step, answers: { firstCode: "9999" } });
    }
    const ended = await add(core, maya, {
      attempt,
      step: 5,
      answers: { firstCode: "9999" },
    });

    expect(ended.json()).toEqual({ ended: "wrong" });
    expect(screens.calls.at(-1)).toBe("cancelAdd tv-1");
    expect(screens.open.size).toBe(0);
    expect(entries(core, "device.add")).toMatchObject([
      { outcome: "refused", reason: "wrongCode" },
    ]);
  });

  it("takes an answer only for the step on the screen", async () => {
    const { core, maya } = await tvsCore();
    const attempt = randomUUID();
    await add(core, maya, { attempt });
    await add(core, maya, { attempt, step: 1, answers: { firstCode: "1234" } });

    // A second press of Continue for the step before.
    const stale = await add(core, maya, {
      attempt,
      step: 1,
      answers: { firstCode: "1234" },
    });

    expect(stale.statusCode).toBe(409);
    expect(screens.calls).toHaveLength(2);
  });

  it("checks a code's digits itself, keeping a leading zero", async () => {
    const { core, maya } = await tvsCore();
    const attempt = randomUUID();
    await add(core, maya, { attempt });
    await add(core, maya, { attempt, step: 1, answers: { firstCode: "1234" } });

    for (const secondCode of ["42", "00x2", "00420", " 042"]) {
      const answered = await add(core, maya, {
        attempt,
        step: 2,
        answers: { secondCode },
      });
      expect(answered.json()).toEqual({ error: "invalid_request" });
    }
    const added = await add(core, maya, {
      attempt,
      step: 2,
      answers: { secondCode: "0042" },
    });
    expect(added.json()).toHaveProperty("added");
  });

  it("asks a code that lasts again, and says when its time is up", async () => {
    const { core, maya } = await tvsCore();
    const attempt = randomUUID();
    await add(core, maya, { attempt });
    await add(core, maya, { attempt, step: 1, answers: { firstCode: "1234" } });

    core.advance(40_000);
    const late = (
      await add(core, maya, {
        attempt,
        step: 2,
        answers: { secondCode: "0042" },
      })
    ).json();
    expect(late).toMatchObject({ step: 2, lastsMs: 0 });
    const again = (
      await add(core, maya, { attempt, step: 2, again: "secondCode" })
    ).json();

    expect(again).toMatchObject({ step: 3, lastsMs: 35_000 });
    expect(screens.calls.at(-1)).toBe("add tv-1 again secondCode");
    // Only a question that lasts is asked again.
    const firstAgain = await add(core, maya, {
      attempt,
      step: 3,
      again: "firstCode",
    });
    expect(firstAgain.json()).toEqual({ error: "invalid_request" });
  });

  it("ends as Cancel asks, and has the driver close the pairing", async () => {
    const { core, maya } = await tvsCore();
    const attempt = randomUUID();
    await add(core, maya, { attempt });

    const cancelled = await cancelAdd(core, maya, attempt);
    const after = await add(core, maya, {
      attempt,
      step: 1,
      answers: { firstCode: "1234" },
    });

    expect(cancelled.json()).toEqual({ ended: "cancelled" });
    expect(after.json()).toEqual({ ended: "cancelled" });
    expect(screens.calls).toEqual(["add tv-1", "cancelAdd tv-1"]);
    expect(screens.attempts.at(-1)).toBe(attempt);
    expect(screens.open.size).toBe(0);
    // Nothing was refused and nothing changed.
    expect(entries(core, "device.add")).toEqual([]);
  });

  it("doesn't start an attempt cancelled before its start arrived", async () => {
    const { core, maya } = await tvsCore();
    const attempt = randomUUID();

    await cancelAdd(core, maya, attempt);
    const started = await add(core, maya, { attempt });

    expect(started.json()).toEqual({ ended: "cancelled" });
    expect(screens.calls).toEqual([]);
  });

  it("waits for a step with the driver, and gives the TV it added", async () => {
    const { core, maya } = await tvsCore();
    const attempt = randomUUID();
    await add(core, maya, { attempt });
    await add(core, maya, { attempt, step: 1, answers: { firstCode: "1234" } });
    const entered = deferredDelivery();
    const release = deferredDelivery();
    screens.beforeStep = () => {
      entered.resolve();
      return release.promise;
    };

    const answer = add(core, maya, {
      attempt,
      step: 2,
      answers: { secondCode: "0042" },
    });
    await entered.promise;
    const turns = core.devices.turns;
    const take = turns.take.bind(turns);
    const queued = deferredDelivery();
    const spy = vi.spyOn(turns, "take").mockImplementation((device, work) => {
      const result = take(device, work);
      queued.resolve();
      return result;
    });
    let cancelled = false;
    const cancel = cancelAdd(core, maya, attempt).then((response) => {
      cancelled = true;
      return response;
    });
    try {
      await queued.promise;
      await settled();
      expect(cancelled).toBe(false);
      expect(screens.calls).not.toContain("cancelAdd tv-1");
    } finally {
      release.resolve();
      spy.mockRestore();
    }

    expect((await answer).json()).toHaveProperty("added");
    expect((await cancel).json()).toHaveProperty("added");
    expect(screens.calls).not.toContain("cancelAdd tv-1");
  });

  it("ends when its time runs out, as the app itself", async () => {
    const { core, maya } = await tvsCore();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const attempt = randomUUID();
    await add(core, maya, { attempt });

    await vi.advanceTimersByTimeAsync(180_000);
    vi.useRealTimers();
    await settled();

    expect(screens.calls).toEqual(["add tv-1", "cancelAdd tv-1"]);
    expect(screens.actors.at(-1)).toEqual({
      kind: "app",
      id: "sanctum.example",
    });
    core.advance(180_000);
    const after = await add(core, maya, {
      attempt,
      step: 1,
      answers: { firstCode: "1234" },
    });
    expect(after.json()).toEqual({ ended: "time" });
  });

  it("is the client's own: another's request finds nothing", async () => {
    const { core, maya } = await tvsCore();
    const tablet = sharedClient(core);
    const attempt = randomUUID();
    await add(core, maya, { attempt });

    const answered = await add(core, tablet, {
      attempt,
      step: 1,
      answers: { firstCode: "1234" },
    });
    const cancelled = await cancelAdd(core, tablet, attempt);

    expect(answered.statusCode).toBe(404);
    expect(cancelled.json()).toEqual({ ended: "cancelled" });
    expect(screens.calls).toEqual(["add tv-1"]);
    expect(screens.open.get("tv-1")).toBe(attempt);
  });

  it("gives way to a newer Add of the same TV, from any screen", async () => {
    const { core, maya } = await tvsCore();
    const tablet = sharedClient(core);
    const first = randomUUID();
    const second = randomUUID();
    await add(core, maya, { attempt: first });

    const replaced = (await add(core, tablet, { attempt: second })).json();
    const old = await add(core, maya, {
      attempt: first,
      step: 1,
      answers: { firstCode: "1234" },
    });

    expect(replaced).toMatchObject({ attempt: second, step: 1 });
    expect(old.json()).toEqual({ ended: "replaced" });
    expect(screens.calls).toEqual(["add tv-1", "cancelAdd tv-1", "add tv-1"]);
    expect(screens.attempts).toEqual([first, first, second]);
  });

  it("leaves the current pairing open when a start is rejected", async () => {
    const { core, maya } = await tvsCore();
    const tablet = sharedClient(core);
    const attempt = randomUUID();
    await add(core, maya, { attempt });

    expect((await add(core, maya, { attempt })).json()).toEqual({
      error: "conflict",
    });
    const cancelled = randomUUID();
    await cancelAdd(core, tablet, cancelled);
    expect((await add(core, tablet, { attempt: cancelled })).json()).toEqual({
      ended: "cancelled",
    });
    expect(screens.calls).toEqual(["add tv-1"]);
    expect(screens.open.get("tv-1")).toBe(attempt);
  });

  it("reserves the client's slots before the driver asks its first questions", async () => {
    const { core, maya } = await tvsCore();
    const keys = ["tv-1", "tv-2", "tv-3", "tv-4", "tv-5"];
    await screens.sayFound(keys.map((key) => ({ key, name: key })));
    const entered = deferredDelivery();
    const overLimit = deferredDelivery();
    const release = deferredDelivery();
    screens.beforeStep = () => {
      if (screens.calls.length === 4) entered.resolve();
      if (screens.calls.length === 5) overLimit.resolve();
      return release.promise;
    };
    const starts = keys
      .slice(0, 4)
      .map((key) => add(core, maya, { key, attempt: randomUUID() }));
    await entered.promise;
    const extra = add(core, maya, { key: "tv-5", attempt: randomUUID() });
    try {
      expect(
        await Promise.race([
          extra.then((reply) => reply.json()),
          overLimit.promise.then(() => "called the driver"),
        ]),
      ).toEqual({
        error: "limited",
      });
    } finally {
      release.resolve();
    }
    for (const response of await Promise.all(starts)) {
      expect(response.json()).toMatchObject({ step: 1 });
    }
    expect(screens.calls).toHaveLength(4);
  });

  it("closes pairing after the driver finishes a step that timed out", async () => {
    const { core, maya } = await tvsCore();
    const entered = deferredDelivery();
    const release = deferredDelivery();
    screens.beforeStep = () => {
      entered.resolve();
      return release.promise;
    };
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const attempt = randomUUID();
    const started = add(core, maya, { attempt });
    await entered.promise;
    try {
      await vi.advanceTimersByTimeAsync(60_000);
      expect((await started).json()).toEqual({ error: "timeout" });
      expect(screens.calls).toEqual(["add tv-1"]);
    } finally {
      release.resolve();
      vi.useRealTimers();
    }
    await vi.waitFor(() =>
      expect(screens.calls).toEqual(["add tv-1", "cancelAdd tv-1"]),
    );
    expect(screens.open.size).toBe(0);
  });

  it("ends an open attempt when the driver restarts", async () => {
    const { core, maya } = await tvsCore();
    const attempt = randomUUID();
    await add(core, maya, { attempt });
    const id = "sanctum.example";
    const run = core.apps.driverRun(id);
    const stopped = await post(
      core,
      `/api/apps/${id}/off`,
      { off: true },
      maya,
    );
    expect(stopped.statusCode).toBe(200);
    await vi.waitFor(() => expect(screens.running).toBe(false));
    const started = await post(
      core,
      `/api/apps/${id}/off`,
      { off: false },
      maya,
    );
    expect(started.statusCode).toBe(200);
    await vi.waitFor(() => expect(core.apps.isRunning(id)).toBe(true));
    expect(core.apps.driverRun(id)).not.toBe(run);

    const answer = await add(core, maya, {
      attempt,
      step: 1,
      answers: { firstCode: "1234" },
    });
    expect(answer.json()).toEqual({ ended: "stopped" });
    expect(screens.calls).toEqual(["add tv-1"]);
  });

  it("is the driver's failure where it asks what it doesn't declare, and ends", async () => {
    const { core, maya } = await tvsCore();
    screens.asksUndeclared = true;

    const started = await add(core, maya, { attempt: randomUUID() });

    expect(started.json()).toEqual({ error: "app_failed" });
    expect(screens.calls).toEqual(["add tv-1", "cancelAdd tv-1"]);
  });

  it("logs a driver's failure without its words, which may hold a code", async () => {
    const { core, maya } = await tvsCore();
    const attempt = randomUUID();
    await add(core, maya, { attempt });
    screens.fails = true;

    const failed = await add(core, maya, {
      attempt,
      step: 1,
      answers: { firstCode: "1234" },
    });

    expect(failed.json()).toEqual({ error: "app_failed" });
    expect(core.logs.join("\n")).not.toContain("1234");
    expect(screens.calls.at(-1)).toBe("cancelAdd tv-1");
  });
});

describe("repairing that asks", () => {
  async function lostTv() {
    const home = await tvsCore();
    await screens.register("tv-9", "Gym");
    await screens.sayProblem("tv-9", "pairingLost");
    await settled();
    const id = home.core.devices
      .list()
      .find((device) => device.driverName === "Gym")!.id;
    return { ...home, tv: id };
  }

  it("pairs again with both codes, then the problem is gone", async () => {
    const { core, maya, tv } = await lostTv();
    const attempt = randomUUID();

    const first = (
      await post(core, "/api/devices/repair", { id: tv, attempt }, maya)
    ).json();
    expect(first).toMatchObject({ step: 1, asks: [{ id: "firstCode" }] });
    await post(
      core,
      "/api/devices/repair",
      { id: tv, attempt, step: 1, answers: { firstCode: "1234" } },
      maya,
    );
    const done = await post(
      core,
      "/api/devices/repair",
      { id: tv, attempt, step: 2, answers: { secondCode: "0042" } },
      maya,
    );

    expect(done.json().repaired).toMatchObject({ id: tv, problem: null });
    expect(entries(core, "device.repair")).toMatchObject([{ outcome: "ok" }]);
  });

  it("ends as the TV is removed, and the driver closes its pairing first", async () => {
    const { core, maya, tv } = await lostTv();
    const attempt = randomUUID();
    await post(core, "/api/devices/repair", { id: tv, attempt }, maya);

    const removed = await post(
      core,
      "/api/devices/remove",
      { id: tv, force: true },
      maya,
    );

    expect(removed.statusCode).toBe(200);
    expect(screens.calls).toEqual(["repair tv-9", "cancelRepair tv-9"]);
    const after = await post(
      core,
      "/api/devices/repair",
      { id: tv, attempt, step: 1, answers: { firstCode: "1234" } },
      maya,
    );
    expect(after.json()).toEqual({ ended: "removed" });
  });

  it("ends where the problem cleared outside it", async () => {
    const { core, maya, tv } = await lostTv();
    const attempt = randomUUID();
    await post(core, "/api/devices/repair", { id: tv, attempt }, maya);
    await screens.sayProblem("tv-9", null);
    await vi.waitFor(() => expect(screens.open.size).toBe(0));
    await screens.sayProblem("tv-9", "pairingLost");

    const answered = await post(
      core,
      "/api/devices/repair",
      { id: tv, attempt, step: 1, answers: { firstCode: "1234" } },
      maya,
    );

    expect(answered.json()).toEqual({ ended: "settled" });
    expect(screens.calls).toEqual(["repair tv-9", "cancelRepair tv-9"]);
  });

  it("keeps Add requests from advancing or cancelling a Repair attempt", async () => {
    const { core, maya, tv } = await lostTv();
    const attempt = randomUUID();
    await post(core, "/api/devices/repair", { id: tv, attempt }, maya);
    const step = { attempt, step: 1, answers: { firstCode: "1234" } };

    const wrong = await add(core, maya, { ...step, key: "tv-9" });
    expect(wrong.json()).toHaveProperty("added");
    await post(
      core,
      "/api/devices/add/cancel",
      { driver: "sanctum.example", key: "tv-9", attempt },
      maya,
    );
    expect(screens.calls).toEqual(["repair tv-9"]);

    const right = await post(
      core,
      "/api/devices/repair",
      { id: tv, ...step },
      maya,
    );
    expect(right.json()).toMatchObject({ step: 2 });
  });

  it("ends as Cancel asks", async () => {
    const { core, maya, tv } = await lostTv();
    const attempt = randomUUID();
    await post(core, "/api/devices/repair", { id: tv, attempt }, maya);

    const cancelled = await post(
      core,
      "/api/devices/repair/cancel",
      { id: tv, attempt },
      maya,
    );

    expect(cancelled.json()).toEqual({ ended: "cancelled" });
    expect(screens.calls).toEqual(["repair tv-9", "cancelRepair tv-9"]);
  });
});

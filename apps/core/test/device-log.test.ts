import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { createActivity } from "../src/activity/activity.js";
import { createDeviceLog, type Sent } from "../src/devices/activity.js";
import { openCoreDatabase } from "../src/database.js";

// What Devices writes to the activity log about a command that went again
// because its device did not confirm it in time (devices/activity.ts).

const closing: (() => void)[] = [];
afterEach(() => {
  for (const close of closing.splice(0)) close();
});

async function deviceLog() {
  const database = openCoreDatabase(
    await mkdtemp(join(tmpdir(), "sanctum-device-log-")),
  );
  closing.push(database.close);
  const clock = { now: Date.parse("2026-10-01T12:00:00Z") };
  const activity = createActivity(database.db, {
    now: () => new Date(clock.now),
  });
  const log = createDeviceLog({ activity, confirmMs: 6_000 });
  const tablet = { clientId: "tablet" };
  const sent = (asked: Record<string, unknown>): Sent => ({
    capability: "light",
    kind: "light",
    asked,
    app: null,
  });
  const commands = () =>
    activity.recent().filter((entry) => entry.action === "device.command");
  return { activity, clock, log, tablet, sent, commands };
}

describe("a command that went again", () => {
  it("says so on its entry, keeping what it asked", async () => {
    const { log, tablet, sent, commands } = await deviceLog();
    const id = log.command(tablet, "lamp", "ok", undefined, sent({ on: true }));
    log.resent(id);
    expect(commands()).toEqual([
      expect.objectContaining({
        outcome: "ok",
        detail: { capability: "light", asked: { on: true }, resent: true },
      }),
    ]);
  });

  it("leaves an entry of several adjustments as it is", async () => {
    const { log, tablet, sent, commands } = await deviceLog();
    log.command(tablet, "lamp", "ok", undefined, sent({ brightness: 40 }));
    const id = log.command(
      tablet,
      "lamp",
      "ok",
      undefined,
      sent({ brightness: 50 }),
    );
    log.resent(id);
    expect(commands()).toEqual([
      expect.objectContaining({
        count: 2,
        detail: {
          capability: "light",
          asked: { brightness: 50 },
          from: { brightness: 40 },
        },
      }),
    ]);
  });

  it("fails with an entry of its own after joining others, keeping their cause", async () => {
    const { activity, log, tablet, sent, commands } = await deviceLog();
    const run = activity.for("workflows")({
      action: "workflow.run",
      outcome: "ok",
    });
    const id = activity.within(run, () => {
      log.command(tablet, "lamp", "ok", undefined, sent({ brightness: 40 }));
      return log.command(
        tablet,
        "lamp",
        "ok",
        undefined,
        sent({ brightness: 50 }),
      );
    });
    log.unanswered(id, tablet, "lamp", sent({ brightness: 50 }), {
      reason: "no_answer",
      hasResent: true,
    });
    expect(commands()).toEqual([
      expect.objectContaining({
        outcome: "failed",
        reason: "no_answer",
        causeId: run,
        detail: {
          capability: "light",
          asked: { brightness: 50 },
          resent: true,
        },
      }),
      expect.objectContaining({ id, outcome: "ok", count: 2, causeId: run }),
    ]);
  });

  it("keeps a joined command without a cause out of an unrelated workflow", async () => {
    const { activity, log, tablet, sent, commands } = await deviceLog();
    log.command(tablet, "lamp", "ok", undefined, sent({ brightness: 40 }));
    const id = log.command(
      tablet,
      "lamp",
      "ok",
      undefined,
      sent({ brightness: 50 }),
    );
    const unrelated = activity.for("workflows")({
      action: "workflow.run",
      outcome: "ok",
    });
    activity.within(unrelated, () =>
      log.unanswered(id, tablet, "lamp", sent({ brightness: 50 }), {
        reason: "no_answer",
        hasResent: true,
      }),
    );
    expect(commands()[0]).toMatchObject({ outcome: "failed", causeId: null });
    expect(activity.causedBy([unrelated])).toEqual([]);
  });

  it("can still be echoed for twice the time to confirm after it last went", async () => {
    const { activity, clock, log } = await deviceLog();
    const setAt = clock.now;
    const lamp = {
      id: "light",
      observed: { on: false },
      sync: "conflict",
      setBy: { at: new Date(setAt).toISOString() },
    } as unknown as Parameters<typeof log.reported>[1];
    const changed = () =>
      activity.recent().filter((entry) => entry.action === "device.changed");
    const sentAt = setAt + 7_000;

    log.reported("lamp", lamp, { on: true }, new Date(sentAt + 11_000), sentAt);
    expect(changed()).toEqual([]);
    log.reported("lamp", lamp, { on: true }, new Date(sentAt + 12_000), sentAt);
    expect(changed()).toHaveLength(1);
  });
});

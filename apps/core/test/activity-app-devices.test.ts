import type { ActivityPage } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { lampsCore, personWithClient } from "./devices-support.js";
import { get, post, type TestCore } from "./support.js";

// An app's action that changes one of its own devices, as a device's page
// does: its entry is about the device, says what the action did, shows in
// the device's own activity, and a person's changes in a row join one entry.

async function activityOf(core: TestCore, token: string, device?: string) {
  const query = device ? `?${new URLSearchParams({ device })}` : "";
  const response = await get(core, `/api/activity${query}`, { token });
  expect(response.statusCode).toBe(200);
  const page: ActivityPage = await response.json();
  return page.entries.filter((entry) => entry.action === "lamps.nudge");
}

const nudge = (
  core: TestCore,
  token: string,
  device: string,
  effect?: "refused" | "failed" | "offline",
) =>
  post(
    core,
    "/api/apps/test.lamps/actions/lamps.nudge",
    { device, effect },
    { token },
  );

describe("an app's action about one of its devices", () => {
  it("is about the device, says what it did, and shows in the device's activity", async () => {
    const { core, maya, lamp } = await lampsCore();

    expect((await nudge(core, maya.token, lamp)).statusCode).toBe(200);

    const [entry] = await activityOf(core, maya.token);
    expect(entry).toMatchObject({
      title: "Nudge it",
      done: "Nudged it",
      count: 1,
      outcome: "ok",
      subject: { type: "device", id: lamp },
      who: { kind: "person" },
    });
    expect(await activityOf(core, maya.token, lamp)).toHaveLength(1);
  });

  it("joins a person's changes in a row, and not someone else's", async () => {
    const { core, maya, lamp } = await lampsCore();
    for (let step = 0; step < 3; step += 1) {
      await nudge(core, maya.token, lamp);
    }
    const ben = personWithClient(core);
    await nudge(core, ben.token, lamp);

    const entries = await activityOf(core, maya.token);
    expect(entries.map((entry) => [entry.who.kind, entry.count])).toEqual([
      ["person", 1],
      ["person", 3],
    ]);
  });

  it("keeps each device's changes to itself, joined across another's", async () => {
    const { core, maya, lamp, plug } = await lampsCore();
    await nudge(core, maya.token, lamp);
    await nudge(core, maya.token, plug);
    await nudge(core, maya.token, lamp);

    const entries = await activityOf(core, maya.token);
    expect(
      entries.map((entry) => [entry.subject?.id, entry.count]).sort(),
    ).toEqual(
      [
        [lamp, 2],
        [plug, 1],
      ].sort(),
    );
  });

  it("is about nothing when its input names no device of the app's", async () => {
    const { core, maya } = await lampsCore();
    await nudge(core, maya.token, "not-a-device");

    const [entry] = await activityOf(core, maya.token);
    expect(entry).toMatchObject({
      title: "Nudge it",
      done: null,
      subject: null,
    });
  });

  it.each(["refused", "failed"] as const)(
    "keeps a %s call out of the success count",
    async (outcome) => {
      const { core, maya, lamp } = await lampsCore();
      await nudge(core, maya.token, lamp);
      core.advance(1_000);
      await nudge(core, maya.token, lamp);
      const [success] = await activityOf(core, maya.token, lamp);

      core.advance(1_000);
      await nudge(core, maya.token, lamp, outcome);

      const entries = await activityOf(core, maya.token, lamp);
      expect(entries).toEqual([
        expect.objectContaining({
          outcome,
          count: 1,
          subject: { ...success!.subject },
        }),
        success,
      ]);
    },
  );

  it("keeps what a call did after its app is removed", async () => {
    const { core, maya, lamp } = await lampsCore({ origin: "official" });
    await nudge(core, maya.token, lamp);
    const [before] = await activityOf(core, maya.token, lamp);

    expect(
      (await post(core, "/api/apps/test.lamps/remove", {}, maya)).statusCode,
    ).toBe(200);

    const [after] = await activityOf(core, maya.token, lamp);
    expect(after).toMatchObject({
      title: "Nudge it",
      done: "Nudged it",
      subject: {
        type: "device",
        id: lamp,
        name: before!.subject!.name,
        gone: true,
      },
    });
  });

  it("names the device when its app is off and cannot take the call", async () => {
    const { core, maya, lamp } = await lampsCore({ origin: "official" });
    expect(
      (await post(core, "/api/apps/test.lamps/off", { off: true }, maya))
        .statusCode,
    ).toBe(200);

    expect((await nudge(core, maya.token, lamp)).statusCode).toBe(503);
    const [entry] = await activityOf(core, maya.token, lamp);
    expect(entry).toMatchObject({
      outcome: "refused",
      reason: "unavailable",
      subject: { id: lamp },
    });
  });

  it("gives activity a device action causes an entry of its own", async () => {
    const { core, maya, lamp } = await lampsCore();
    await nudge(core, maya.token, lamp);
    const [first] = await activityOf(core, maya.token, lamp);
    await nudge(core, maya.token, lamp, "offline");

    const entries = await activityOf(core, maya.token, lamp);
    expect(entries.map(({ count }) => count)).toEqual([1, 1]);
    const offline = core.activity
      .recent()
      .find(({ action }) => action === "device.offline");
    expect(offline?.causeId).toBe(entries[0]!.id);
    expect(entries[1]!.id).toBe(first!.id);
  });

  it.each(["device.press", "workflow.run"])(
    "keeps the caller when an app action is named %s",
    async (action) => {
      const { core, maya, lamp } = await lampsCore();
      const id = core.activity.for("sanctum.example")({
        action,
        outcome: "ok",
        subjectId: lamp,
        personId: maya.person.id,
        detail: { actionTitle: "Nudge it", actionDone: "Nudged it" },
      });

      expect(core.activityViews.info(core.activity.get(id)!)).toMatchObject({
        subject: { type: "device", id: lamp },
        who: { kind: "person", id: maya.person.id },
        run: null,
        caused: null,
      });
    },
  );
});

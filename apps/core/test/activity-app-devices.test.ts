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

const nudge = (core: TestCore, token: string, device: string) =>
  post(core, "/api/apps/test.lamps/actions/lamps.nudge", { device }, { token });

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
    expect(entry).toMatchObject({ done: "Nudged it", subject: null });
  });
});

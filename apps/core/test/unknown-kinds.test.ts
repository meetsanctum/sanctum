import { eq } from "drizzle-orm";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { lampsCore, radio, settled } from "./devices-support.js";
import { loadAppPackage } from "./runner-apps.js";
import { deviceCapabilities } from "../src/devices/schema.js";
import { historySeries, historyStates } from "../src/history/schema.js";
import { fixtureApps, get, testCore, type TestCore } from "./support.js";

// A core's database can hold capabilities of a kind its build doesn't have,
// as one written by a build that had the kind. The core starts and serves its
// devices without them, and a driver that registers one again with a kind the
// build has brings it back, starting afresh.

async function deviceOf(core: TestCore, token: string, id: string) {
  const devices = (await get(core, "/api/devices", { token })).json();
  return devices.find((each: { id: string }) => each.id === id);
}

const statesOf = (
  core: TestCore,
  token: string,
  device: string,
  part: string,
) =>
  get(core, `/api/history/states?device=${device}&capability=${part}`, {
    token,
  });

describe("a capability of a kind this build doesn't have", () => {
  it("is left out until its driver registers it again", async () => {
    const { core: first, maya } = await lampsCore();
    await radio.add("motion-1", "motion", "Desk motion");
    await settled();
    const devices = (
      await get(first, "/api/devices", { token: maya.token })
    ).json() as { id: string; driverName: string }[];
    const desk = devices.find((each) => each.driverName === "Desk motion")!.id;
    // Reading its history writes what was recorded so far.
    const recorded = await statesOf(first, maya.token, desk, "occupancy");
    expect(recorded.json().states.length).toBeGreaterThan(0);
    await first.apps.close();
    // What a build with a kind this one doesn't have left behind.
    first.db
      .update(deviceCapabilities)
      .set({ kind: "occupancy" as never, observed: { occupied: true } })
      .where(eq(deviceCapabilities.id, "occupancy"))
      .run();
    const [retired] = first.db
      .update(historySeries)
      .set({ kind: "occupancy" as never })
      .where(eq(historySeries.capabilityId, "occupancy"))
      .returning({ id: historySeries.id })
      .all();
    first.db
      .update(historyStates)
      .set({ state: { occupied: true } })
      .where(eq(historyStates.seriesId, retired!.id))
      .run();

    const second = await testCore({ dataDir: first.dataDir });
    const left = await deviceOf(second, maya.token, desk);

    expect(left.capabilities.map((each: { id: string }) => each.id)).toEqual([
      "illuminance",
      "temperature",
    ]);
    expect(
      (await statesOf(second, maya.token, desk, "illuminance")).statusCode,
    ).toBe(200);
    expect(
      (await statesOf(second, maya.token, desk, "occupancy")).statusCode,
    ).toBe(404);

    await second.startApps([
      await loadAppPackage(join(fixtureApps, "lamps"), "system"),
    ]);
    await settled();
    await radio.press("motion-1", { motion: true });
    await settled();

    expect(
      (await deviceOf(second, maya.token, desk)).capabilities[0],
    ).toMatchObject({
      id: "occupancy",
      kind: "motion",
      state: { motion: true },
    });
    // Its history starts afresh, with nothing of the kind before.
    const afresh = (
      await statesOf(second, maya.token, desk, "occupancy")
    ).json();
    expect(afresh.kind).toBe("motion");
    expect(
      afresh.states.every(
        (each: { state: object | null }) =>
          each.state === null || "motion" in each.state,
      ),
    ).toBe(true);
    expect(afresh.states.at(-1).state).toMatchObject({ motion: true });
  });
});

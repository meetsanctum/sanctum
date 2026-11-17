import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { appsRemoved } from "../src/app-host/schema.js";
import { lampsCore } from "./devices-support.js";
import { loadAppPackage } from "./runner-apps.js";
import { fixtureApps, get, post, type TestCore } from "./support.js";
import { addWorkflow, steps, trigger } from "./workflows-support.js";

// Removing an app from its settings: what leaves the home at once, what the
// household's workflows do, what's kept, and adding it back while it is.

const lightStep = (device: string) => ({
  id: "lamp",
  kind: "step" as const,
  piece: "device",
  config: { device, capability: "light", command: { on: true } },
});

async function home() {
  const { core, maya, lamp, plug } = await lampsCore({ origin: "official" });
  const { id: evening } = await addWorkflow(core, maya.token, {
    name: "Evening",
    graph: steps(trigger("hand", "manual"), lightStep(lamp)),
  });
  const { id: spare } = await addWorkflow(core, maya.token, {
    name: "Spare",
    enabled: false,
    graph: steps(trigger("hand", "manual"), lightStep(lamp)),
  });
  return { core, maya, lamp, plug, evening, spare };
}

const workflow = (core: TestCore, id: string) => core.workflows.get(id);

describe("removing an app", () => {
  it("says first what it takes: its devices and the workflows that use them", async () => {
    const { core, maya, evening } = await home();

    const response = await get(core, "/api/apps/test.lamps/removal", maya);

    expect(response.statusCode).toBe(200);
    // One that's off already doesn't turn off.
    expect(response.json()).toEqual({
      devices: 2,
      workflows: [{ id: evening, name: "Evening" }],
      widgets: 0,
      roomSections: 0,
    });
  });

  it("takes it and its devices from the home, turns off what uses it, and keeps a record", async () => {
    const { core, maya, lamp, evening, spare } = await home();

    const response = await post(core, "/api/apps/test.lamps/remove", {}, maya);

    expect(response.statusCode).toBe(200);
    const apps = (await get(core, "/api/apps", maya)).json() as {
      id: string;
    }[];
    expect(apps.map((app) => app.id)).not.toContain("test.lamps");
    const devices = (await get(core, "/api/devices", maya)).json() as {
      id: string;
    }[];
    expect(devices.map((device) => device.id)).not.toContain(lamp);
    expect(await workflow(core, evening)).toMatchObject({
      enabled: false,
    });
    expect(await workflow(core, spare)).toMatchObject({
      enabled: false,
    });
    expect(core.db.select().from(appsRemoved).all()).toEqual([
      expect.objectContaining({
        appId: "test.lamps",
        name: "Lamps",
        isDone: true,
      }),
    ]);
    expect(
      core.activity
        .recent()
        .filter((entry) => entry.action === "app.remove")
        .map(({ outcome, subjectId, kind }) => ({ outcome, subjectId, kind })),
    ).toEqual([{ outcome: "ok", subjectId: "test.lamps", kind: "setup" }]);
  });

  it("finishes at start what a core that stopped part way left", async () => {
    const { core } = await home();
    // As a core that stopped after its first transaction leaves it.
    core.removedApps.record(
      "test.gone",
      {},
      { name: "Gone", version: "1.0.0" },
    );

    await core.appRemoving.resume();

    expect(core.removedApps.get("test.gone")).toMatchObject({ isDone: true });
  });

  it("keeps a system app", async () => {
    const { core, maya } = await home();

    const response = await post(core, "/api/apps/test.panel/remove", {}, maya);

    expect(response.statusCode).toBe(403);
    expect(
      (await get(core, "/api/apps", maya))
        .json()
        .map((app: { id: string }) => app.id),
    ).toContain("test.panel");
  });

  it("is the household's, for every client", async () => {
    const { core } = await home();
    expect(
      (await post(core, "/api/apps/test.lamps/remove", {})).statusCode,
    ).toBe(401);
  });

  it("brings back its devices, and turns back on what it turned off unless someone changed it, when it's added back", async () => {
    const { core, maya, lamp, evening, spare } = await home();
    await post(core, "/api/apps/test.lamps/remove", {}, maya);
    // As adding it back does, once it's installed again.
    core.removedApps.forget("test.lamps");
    await core.startApps([await lampsPackage()]);
    const on = core.workflows.forApps.added("test.lamps");

    expect(on).toEqual(["Evening"]);
    expect(await workflow(core, evening)).toMatchObject({
      enabled: true,
    });
    // It was off before, so it stays off.
    expect(await workflow(core, spare)).toMatchObject({
      enabled: false,
    });
    const devices = (await get(core, "/api/devices", maya)).json() as {
      id: string;
    }[];
    expect(devices.map((device) => device.id)).toContain(lamp);
  });

  it("leaves off a workflow someone changed while it was gone", async () => {
    const { core, maya, evening } = await home();
    await post(core, "/api/apps/test.lamps/remove", {}, maya);
    core.advance(60_000);
    await post(
      core,
      "/api/workflows/update",
      { id: evening, name: "Evening lights" },
      maya,
    );

    core.removedApps.forget("test.lamps");
    await core.startApps([await lampsPackage()]);

    expect(core.workflows.forApps.added("test.lamps")).toEqual([]);
    expect(await workflow(core, evening)).toMatchObject({
      enabled: false,
    });
  });
});

const lampsPackage = () =>
  loadAppPackage(join(fixtureApps, "lamps"), "official");

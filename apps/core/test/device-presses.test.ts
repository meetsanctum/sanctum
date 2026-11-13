import {
  defineApp,
  type DevicePressEvent,
  type WorkflowInfo,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import type { AppPackage } from "./runner-apps.js";
import {
  lampsCore,
  openLive,
  personWithClient,
  radio,
  settled,
} from "./devices-support.js";
import { get, post, sharedClient, type TestCore } from "./support.js";
import {
  addWorkflow,
  samplePackage,
  noteStep,
  runsOf,
  steps,
  trigger,
} from "./workflows-support.js";

// Remotes' presses: a driver hands each press to the core, which passes it on
// once to live clients, to running apps that follow device.pressed and to
// workflows' press triggers, unless someone is capturing the remote's presses.

// An app that follows remotes' presses and keeps what reaches it; it pauses
// without the permissions it needs.
function pressListener(permissions: string[], needed: string[] = []) {
  const heard: DevicePressEvent[] = [];
  const app = defineApp({
    id: "test.presses",
    name: "Presses",
    version: "0.1.0",
    core: "^1.0.0",
    permissions: [...permissions, ...needed].map((id) => ({
      id,
      reason: "For the test.",
      needed: needed.includes(id),
    })),
    actions: [],
    events: [],
    async start(ctx) {
      await ctx.events.on("device.pressed", (event) => {
        heard.push(event);
      });
    },
  });
  return { pkg: { app, origin: "system" } satisfies AppPackage, heard };
}

// A home with two remotes and the sample app's steps, which workflows
// note with.
async function remotesHome(apps: readonly AppPackage[] = []) {
  const home = await lampsCore({ apps: [samplePackage, ...apps] });
  await radio.add("remote-1", "button", "Office remote");
  await radio.add("remote-2", "button", "Hall remote");
  const devices = (
    await get(home.core, "/api/devices", { token: home.maya.token })
  ).json() as { id: string; driverName: string }[];
  const idOf = (name: string) =>
    devices.find((device) => device.driverName === name)!.id;
  return {
    ...home,
    office: idOf("Office remote"),
    hall: idOf("Hall remote"),
  };
}

const pressTrigger = (device: string, action?: string) =>
  trigger("pressed", "press", { device, ...(action && { action }) });

async function noted(core: TestCore, token: string, workflow: string) {
  await core.workflows.settled();
  return (await runsOf(core, token, workflow)).length;
}

describe("a remote", () => {
  it("is a button with the presses it declares, named as one", async () => {
    const { core, maya, office } = await remotesHome();

    expect(core.devices.get(office)).toMatchObject({
      name: "Button",
      capabilities: [
        {
          id: "button",
          kind: "button",
          features: { actions: ["single", "double", "hold"] },
          state: null,
        },
      ],
    });
    await post(core, "/api/places/rooms/add", { name: "Office" }, maya);
    const room = core.places.list().rooms[0]!.id;
    await post(core, "/api/devices/update", { id: office, roomId: room }, maya);

    expect(core.devices.get(office)?.name).toBe("Office button");
  });

  it("sends each press to live clients once, as it happens, and answers", async () => {
    const { core, maya, office } = await remotesHome();
    const live = await openLive(core, maya.token);
    const tablet = await openLive(core, sharedClient(core).token);
    core.advance(60_000);

    await radio.pressButton("remote-1", "single");
    await radio.pressButton("remote-1", "single");
    await radio.pressButton("remote-1", "double");
    await settled();

    const presses = [
      { type: "press", device: office, capability: "button", action: "single" },
      { type: "press", device: office, capability: "button", action: "single" },
      { type: "press", device: office, capability: "button", action: "double" },
    ].map((press) => ({
      ...press,
      at: core.now().toISOString(),
      isCaptured: false,
    }));
    expect(live.messages.filter((each) => each.type === "press")).toEqual(
      presses,
    );
    expect(tablet.messages.filter((each) => each.type === "press")).toEqual(
      presses,
    );
    expect(core.devices.get(office)).toMatchObject({
      availability: "online",
      lastSeenAt: core.now().toISOString(),
    });
  });

  it("refuses a press its button does not declare, and one of a device with no button", async () => {
    const { core, maya } = await remotesHome();
    const live = await openLive(core, maya.token);

    await expect(radio.pressButton("remote-1", "triple")).rejects.toThrow(
      /does not declare/,
    );
    await expect(radio.pressButton("lamp-1", "single")).rejects.toMatchObject({
      name: "ActionError",
      code: "not_found",
    });
    await settled();
    expect(live.messages.filter((each) => each.type === "press")).toEqual([]);
  });
});

describe("the press trigger", () => {
  it("matches actions on any button unless a capability is selected", async () => {
    const { core, maya } = await remotesHome();
    const { id: device } = core.devices.register("test.lamps", {
      key: "multi-button",
      name: "Remote",
      capabilities: [
        { id: "left", kind: "button", features: { actions: ["single"] } },
        { id: "right", kind: "button", features: { actions: ["double"] } },
      ],
    });
    const { id } = await addWorkflow(core, maya.token, {
      graph: steps(pressTrigger(device, "double"), noteStep("note")),
    });
    core.presses.press("test.lamps", {
      key: "multi-button",
      capability: "right",
      action: "double",
    });
    expect(await noted(core, maya.token, id)).toBe(1);

    const response = await post(
      core,
      "/api/workflows/add",
      {
        name: "Wrong button",
        graph: steps(
          trigger("pressed", "press", {
            device,
            capability: "left",
            action: "double",
          }),
          noteStep("note"),
        ),
      },
      maya,
    );
    expect(response.json()).toMatchObject({ error: "invalid_workflow" });
  });

  it("runs a workflow once for each press of its remote's action", async () => {
    const { core, maya, office } = await remotesHome();
    // Queued, so a press while the last one's run is going waits its turn.
    const { id } = await addWorkflow(core, maya.token, {
      runMode: "queued",
      graph: steps(pressTrigger(office, "single"), noteStep("note")),
    });

    await radio.pressButton("remote-1", "single");
    await radio.pressButton("remote-1", "double");
    await radio.pressButton("remote-2", "single");
    await radio.pressButton("remote-1", "single");

    await core.workflows.settled();
    const runs = await runsOf(core, maya.token, id);
    expect(runs.map((run) => run.status)).toEqual(["succeeded", "succeeded"]);
    expect(runs[0]!.trigger.data).toEqual({
      device: office,
      capability: "button",
      action: "single",
    });
  });

  // Thirty-five presses, each crossing the sockets of the driver and of the app
  // the workflow's step calls.
  it(
    "runs however often the remote is pressed, since a press never loops",
    {
      timeout: 20_000,
    },
    async () => {
      const { core, maya, office } = await remotesHome();
      const { id } = await addWorkflow(core, maya.token, {
        runMode: "parallel",
        graph: steps(pressTrigger(office, "single"), noteStep("note")),
      });

      for (let press = 0; press < 35; press++) {
        await radio.pressButton("remote-1", "single");
      }

      await core.workflows.settled();
      const runs = await runsOf(core, maya.token, id);
      expect(runs).toHaveLength(35);
      expect(runs.every((run) => run.status === "succeeded")).toBe(true);
    },
  );

  it("runs for any of the remote's presses when it names no action", async () => {
    const { core, maya, office } = await remotesHome();
    const { id } = await addWorkflow(core, maya.token, {
      runMode: "queued",
      graph: steps(pressTrigger(office), noteStep("note")),
    });

    await radio.pressButton("remote-1", "single");
    await radio.pressButton("remote-1", "hold");

    expect(await noted(core, maya.token, id)).toBe(2);
  });

  it("cannot be saved for a device with no button or an action it does not declare", async () => {
    const { core, maya, lamp, office } = await remotesHome();

    for (const [config, field, message] of [
      [{ device: lamp }, "device", `There is no device ${lamp} with a button`],
      [
        { device: office, action: "triple" },
        "action",
        "Button has no action triple",
      ],
      [
        { device: office, capability: "power" },
        "capability",
        `There is no device ${office} with a button power`,
      ],
    ] as const) {
      const response = await post(
        core,
        "/api/workflows/add",
        {
          name: "Press",
          graph: steps(trigger("pressed", "press", config), noteStep("note")),
        },
        maya,
      );
      expect(response.json()).toEqual({
        error: "invalid_workflow",
        problems: [{ node: "pressed", field, message }],
      });
    }
  });

  it("is broken once its remote is removed", async () => {
    const { core, maya, office } = await remotesHome();
    const { id } = await addWorkflow(core, maya.token, {
      graph: steps(pressTrigger(office, "single"), noteStep("note")),
    });

    await post(core, "/api/devices/remove", { id: office, force: true }, maya);

    const [workflow] = (
      await get(core, "/api/workflows", { token: maya.token })
    ).json() as WorkflowInfo[];
    expect(workflow).toMatchObject({
      id,
      problems: [
        {
          node: "pressed",
          field: "device",
          message: "The device it names was removed",
        },
      ],
    });
  });
});

describe("capturing a remote's presses", () => {
  it("holds them back from workflows and apps, for that remote only, while live clients still get them", async () => {
    const listener = pressListener(["devices.read:button"]);
    const { core, maya, office, hall } = await remotesHome([listener.pkg]);
    const officeWorkflow = await addWorkflow(core, maya.token, {
      graph: steps(pressTrigger(office, "single"), noteStep("office")),
    });
    const hallWorkflow = await addWorkflow(core, maya.token, {
      graph: steps(pressTrigger(hall, "single"), noteStep("hall")),
    });
    const live = await openLive(core, maya.token);

    const capture = await post(
      core,
      "/api/devices/capture/start",
      { device: office },
      maya,
    );
    expect(capture.json()).toEqual({
      id: expect.any(String),
      device: office,
      until: new Date(core.now().getTime() + 5 * 60_000).toISOString(),
    });
    await radio.pressButton("remote-1", "single");
    await radio.pressButton("remote-2", "single");
    await settled();

    expect(await noted(core, maya.token, officeWorkflow.id)).toBe(0);
    expect(await noted(core, maya.token, hallWorkflow.id)).toBe(1);
    expect(
      live.messages
        .filter((each) => each.type === "press")
        .map((each) => each.device),
    ).toEqual([office, hall]);
    expect(listener.heard.map((event) => event.device.id)).toEqual([hall]);
    expect(
      live.messages
        .filter((each) => each.type === "press")
        .map((each) => each.isCaptured),
    ).toEqual([true, false]);

    const stopped = await post(
      core,
      "/api/devices/capture/stop",
      { id: capture.json().id },
      maya,
    );
    expect(stopped.statusCode).toBe(204);
    await radio.pressButton("remote-1", "single");
    await settled();

    expect(await noted(core, maya.token, officeWorkflow.id)).toBe(1);
    expect(listener.heard.map((event) => event.device.id)).toEqual([
      hall,
      office,
    ]);
  });

  it("ends after five minutes at most", async () => {
    const { core, maya, office } = await remotesHome();
    const { id } = await addWorkflow(core, maya.token, {
      graph: steps(pressTrigger(office, "single"), noteStep("note")),
    });

    await post(core, "/api/devices/capture/start", { device: office }, maya);
    core.advance(5 * 60_000 + 1);
    await radio.pressButton("remote-1", "single");

    expect(await noted(core, maya.token, id)).toBe(1);
  });

  it("is for every client, shared ones too", async () => {
    const { core, office } = await remotesHome();
    const start = (token: string) =>
      post(core, "/api/devices/capture/start", { device: office }, { token });

    expect((await start(personWithClient(core).token)).statusCode).toBe(200);
    expect((await start(sharedClient(core).token)).statusCode).toBe(200);
  });

  it("needs a remote, and says what it needs", async () => {
    const { core, maya, lamp } = await remotesHome();

    expect(
      (await post(core, "/api/devices/capture/start", { device: lamp }, maya))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await post(
          core,
          "/api/devices/capture/start",
          { scope: { type: "global" } },
          maya,
        )
      ).json(),
    ).toEqual({ error: "invalid_request" });
    // Stopping one that has ended already is no error.
    expect(
      (await post(core, "/api/devices/capture/stop", { id: "gone" }, maya))
        .statusCode,
    ).toBe(204);
  });
});

describe("an app's page capturing a remote's presses", () => {
  const capture = (core: TestCore, token: string, device: string) =>
    post(
      core,
      "/api/devices/capture/start",
      { device, app: "test.presses" },
      { token },
    );
  const grant = (
    core: TestCore,
    token: string,
    permission: string,
    granted: boolean,
  ) =>
    core.apps.setPermission({
      principal: core.auth.clients.authenticate(token)!,
      appId: "test.presses",
      permission,
      granted,
    });

  it("needs the app to read remotes' buttons", async () => {
    const reads = pressListener(["devices.read:button"]);
    const home = await remotesHome([reads.pkg]);
    expect(
      (await capture(home.core, home.maya.token, home.office)).statusCode,
    ).toBe(200);

    // It runs, reading only lights, so what refuses it is the permission.
    const blind = defineApp({
      id: "test.presses",
      name: "Presses",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [{ id: "devices.read:light", reason: "For the test." }],
      actions: [],
      events: [],
    });
    const other = await remotesHome([{ app: blind, origin: "system" }]);
    expect(
      (await capture(other.core, other.maya.token, other.office)).json(),
    ).toEqual({ error: "forbidden" });
    expect(
      (
        await post(
          other.core,
          "/api/devices/capture/start",
          { device: other.office, app: "test.missing" },
          other.maya,
        )
      ).statusCode,
    ).toBe(404);
  });

  it("ends when the app may no longer read buttons", async () => {
    const listener = pressListener(["devices.read:button"]);
    const { core, maya, office } = await remotesHome([listener.pkg]);
    const { id } = await addWorkflow(core, maya.token, {
      graph: steps(pressTrigger(office, "single"), noteStep("note")),
    });
    await capture(core, maya.token, office);

    await grant(core, maya.token, "devices.read:button", false);
    await radio.pressButton("remote-1", "single");

    expect(await noted(core, maya.token, id)).toBe(1);
  });

  it("ends when the app pauses, and waits for it to run again", async () => {
    const listener = pressListener([], ["devices.read:button", "places.read"]);
    const { core, maya, office } = await remotesHome([listener.pkg]);
    const { id } = await addWorkflow(core, maya.token, {
      graph: steps(pressTrigger(office, "single"), noteStep("note")),
    });
    await capture(core, maya.token, office);

    await grant(core, maya.token, "places.read", false);
    await settled();
    await radio.pressButton("remote-1", "single");

    expect(await noted(core, maya.token, id)).toBe(1);
    expect((await capture(core, maya.token, office)).json()).toEqual({
      error: "unavailable",
    });
  });

  it("is stopped only by the client that asked", async () => {
    const listener = pressListener(["devices.read:button"]);
    const { core, maya, office } = await remotesHome([listener.pkg]);
    const { id: workflow } = await addWorkflow(core, maya.token, {
      graph: steps(pressTrigger(office, "single"), noteStep("note")),
    });
    const { id } = (await capture(core, maya.token, office)).json();

    await post(
      core,
      "/api/devices/capture/stop",
      { id },
      { token: sharedClient(core).token },
    );
    await radio.pressButton("remote-1", "single");
    expect(await noted(core, maya.token, workflow)).toBe(0);

    await post(core, "/api/devices/capture/stop", { id }, maya);
    await radio.pressButton("remote-1", "single");
    expect(await noted(core, maya.token, workflow)).toBe(1);
  });
});

describe("device.pressed", () => {
  it("reaches apps that may read buttons, with the remote as they see it", async () => {
    const listener = pressListener(["devices.read:button"]);
    const { office } = await remotesHome([listener.pkg]);

    await radio.pressButton("remote-1", "hold");
    await settled();

    expect(listener.heard).toEqual([
      {
        name: "device.pressed",
        device: expect.objectContaining({
          id: office,
          capabilities: [expect.objectContaining({ kind: "button" })],
        }),
        capability: "button",
        action: "hold",
      },
    ]);
  });
});

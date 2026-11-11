import { drizzle } from "drizzle-orm/sqlite-proxy";
import { describe, expect, it } from "vitest";

import type { CapabilityInfo } from "@meetsanctum/app-sdk";

import { choosePress, listPresses } from "../src/presses/actions.js";
import {
  buttonOf,
  choose,
  readPresses,
  syncPresses,
} from "../src/presses/presses.js";
import { startableHome } from "./moods/core.js";
import { device, lightCapability } from "./moods/home.js";

const remote = () =>
  device("remote", "office", [
    {
      id: "button",
      kind: "button",
      features: { actions: ["single"], holds: [] },
      state: null,
      observed: null,
      desired: null,
      sync: "synced",
      setBy: null,
      changedAt: null,
    },
  ]);

const roomToggle = {
  kind: "lights" as const,
  place: { kind: "room" as const, id: "office" },
  to: "toggle" as const,
};

const homeOff = {
  kind: "lights" as const,
  place: { kind: "home" as const },
  to: "off" as const,
};

describe("syncing a remote's choices", () => {
  it("lists each action across all of a remote's button capabilities", () => {
    const button = {
      kind: "button" as const,
      state: null,
      observed: null,
      desired: null,
      sync: "synced" as const,
      setBy: null,
      changedAt: null,
    };
    const remote = device("remote", "office", [
      {
        ...button,
        id: "left",
        features: { actions: ["single", "hold"], holds: ["hold"] },
      },
      {
        ...button,
        id: "right",
        features: { actions: ["double", "single"], holds: [] },
      },
    ]);
    expect(buttonOf(remote)?.features).toEqual({
      actions: ["single", "hold", "double"],
      holds: ["hold"],
    });
  });

  it("preserves a new choice while cleaning up an older invalid choice", async () => {
    const remote = device("remote", "office", [
      {
        id: "button",
        kind: "button",
        features: { actions: ["single"], holds: [] },
        state: null,
        observed: null,
        desired: null,
        sync: "synced",
        setBy: null,
        changedAt: null,
      },
    ]);
    const home = startableHome({ devices: [remote] });
    const db = drizzle(async (sql, params, method) => {
      const { rows } = await home.storage.query({ sql, params, method });
      return { rows: rows as unknown[] };
    });
    await choose(db, remote.id, "single", {
      kind: "lights",
      place: { kind: "room", id: "removed-room" },
      to: "toggle",
    });
    const hold = home.holdDevices();
    const starting = home.start();
    await hold.reached;
    try {
      // A save replaces the invalid row after sync has read it, while the
      // rest of its snapshot is still loading.
      await choose(db, remote.id, "single", { kind: "nothing" });
    } finally {
      hold.release();
    }
    await starting;
    expect((await readPresses(db, remote.id)).get("single")).toEqual({
      kind: "nothing",
    });
  });

  it("restores the default workflow when the first choice cannot be put", async () => {
    const home = startableHome({ devices: [remote()] });
    await home.start();
    home.state.failWorkflowPuts = 1;

    await expect(
      home.call(choosePress, {
        device: "remote",
        action: "single",
        choice: roomToggle,
      }),
    ).rejects.toThrow("workflow put failed");

    expect(await home.call(listPresses, { device: "remote" })).toEqual({
      presses: [
        { action: "single", choice: null, default: roomToggle, hold: false },
      ],
      defaults: { roomId: "office", dimmer: false },
    });
    expect([...home.state.workflows.keys()]).toEqual(["default:remote"]);
  });

  it("restores an existing binding when its replacement cannot be put", async () => {
    const home = startableHome({ devices: [remote()] });
    await home.start();
    await home.call(choosePress, {
      device: "remote",
      action: "single",
      choice: roomToggle,
    });
    const before = structuredClone(
      home.state.workflows.get("press:remote:single"),
    );
    home.state.failWorkflowPuts = 1;

    await expect(
      home.call(choosePress, {
        device: "remote",
        action: "single",
        choice: homeOff,
      }),
    ).rejects.toThrow("workflow put failed");

    expect(await home.call(listPresses, { device: "remote" })).toEqual({
      presses: [
        {
          action: "single",
          choice: roomToggle,
          default: roomToggle,
          hold: false,
        },
      ],
      defaults: { roomId: "office", dimmer: false },
    });
    expect(home.state.workflows.get("press:remote:single")).toEqual(before);
  });

  it("keeps a later queued save after an earlier save rolls back", async () => {
    const home = startableHome({ devices: [remote()] });
    await home.start();
    home.state.failWorkflowPuts = 1;
    const hold = home.holdDevices();
    const first = home.call(choosePress, {
      device: "remote",
      action: "single",
      choice: roomToggle,
    });
    await hold.reached;
    const later = home.call(choosePress, {
      device: "remote",
      action: "single",
      choice: homeOff,
    });
    hold.release();

    await expect(first).rejects.toThrow("workflow put failed");
    await later;

    expect(await home.call(listPresses, { device: "remote" })).toEqual({
      presses: [
        { action: "single", choice: homeOff, default: roomToggle, hold: false },
      ],
      defaults: { roomId: "office", dimmer: false },
    });
    expect(home.state.workflows.has("press:remote:single")).toBe(true);
    expect(home.state.workflows.has("default:remote")).toBe(false);
    expect(home.state.workflows.get("press:remote:single")).toMatchObject({
      graph: {
        nodes: [
          { config: { device: "remote", action: "single" } },
          { config: { place: { kind: "home" }, to: "off" } },
        ],
      },
    });
  });
});

// v1's office dimmer, a Hue dimmer switch gen 1 (RWL021), as Zigbee2MQTT
// declares it, and two lights of the office's.
const dimmer = () =>
  device("dimmer", "office", [
    {
      id: "button",
      kind: "button",
      features: {
        actions: ["on", "up", "down", "off"].flatMap((button) => [
          `${button}_press`,
          `${button}_hold`,
        ]),
        holds: ["on_hold", "up_hold", "down_hold", "off_hold"],
      },
      state: null,
      observed: null,
      desired: null,
      sync: "synced",
      setBy: null,
      changedAt: null,
    } satisfies CapabilityInfo,
  ]);
const lamp = (id: string) =>
  device(id, "office", [lightCapability({ on: true, brightness: 40 })]);

describe("a remote's defaults", () => {
  it("make a remote with up and down buttons a dimmer for its room, in one workflow", async () => {
    const home = startableHome({ devices: [dimmer()] });
    await home.start();

    const listed = await home.call(listPresses, { device: "dimmer" });
    expect(listed.defaults).toEqual({ roomId: "office", dimmer: true });
    expect(
      listed.presses.map((press) => [
        press.action,
        press.hold,
        press.default?.kind === "lights" && press.default.to,
      ]),
    ).toEqual([
      ["on_press", false, "on"],
      // Holding on or off is there to choose.
      ["on_hold", true, false],
      ["up_press", false, "brighter"],
      ["up_hold", true, "brightenWhileHeld"],
      ["down_press", false, "dimmer"],
      ["down_hold", true, "dimWhileHeld"],
      ["off_press", false, "off"],
      ["off_hold", true, false],
    ]);
    const { graph, name } = home.state.workflows.get("default:dimmer")!;
    expect(name).toBe("dimmer: presses not chosen");
    // A trigger for each press, and a step for each thing they do.
    expect(graph.nodes.filter((node) => node.kind === "trigger")).toHaveLength(
      6,
    );
    expect(
      graph.nodes
        .filter((node) => node.kind === "step")
        .map((node) => node.config.to),
    ).toEqual([
      "on",
      "brighter",
      "brightenWhileHeld",
      "dimmer",
      "dimWhileHeld",
      "off",
    ]);
    expect(graph.edges).toContainEqual({ from: "pressed-6", to: "step-6" });
  });

  it("keep each press not chosen when another is", async () => {
    const home = startableHome({ devices: [dimmer()] });
    await home.start();

    await home.call(choosePress, {
      device: "dimmer",
      action: "up_hold",
      choice: { kind: "nothing" },
    });

    const { graph } = home.state.workflows.get("default:dimmer")!;
    expect(
      graph.nodes
        .filter((node) => node.kind === "trigger")
        .map((node) => node.config.action),
    ).toEqual(["on_press", "up_press", "down_press", "down_hold", "off_press"]);
    expect(home.state.workflows.has("press:dimmer:up_hold")).toBe(false);
  });

  it("brighten or dim by turns on a hold of a remote with one button", async () => {
    const home = startableHome({
      devices: [
        device("button", "office", [
          {
            id: "button",
            kind: "button",
            features: { actions: ["single", "hold"], holds: ["hold"] },
            state: null,
            observed: null,
            desired: null,
            sync: "synced",
            setBy: null,
            changedAt: null,
          },
        ]),
      ],
    });
    await home.start();

    const listed = await home.call(listPresses, { device: "button" });
    expect(listed.presses.map((press) => press.default)).toEqual([
      roomToggle,
      { ...roomToggle, to: "brightenOrDimWhileHeld" },
    ]);
    expect(listed.defaults).toEqual({ roomId: "office", dimmer: false });
  });
});

describe("chosen lights", () => {
  const someLights = (lights: string[]) => ({
    kind: "lights" as const,
    place: {
      kind: "lights" as const,
      lights: lights.map((id) => ({ device: id, capability: "light" })),
    },
    to: "brightenWhileHeld" as const,
  });

  it("are what a press's workflow brightens while held", async () => {
    const home = startableHome({
      devices: [dimmer(), lamp("desk"), lamp("shelf")],
    });
    await home.start();

    await home.call(choosePress, {
      device: "dimmer",
      action: "up_hold",
      choice: someLights(["desk", "shelf"]),
    });

    expect(
      home.state.workflows.get("press:dimmer:up_hold")!.graph.nodes[1],
    ).toMatchObject({
      piece: "lights",
      config: {
        place: {
          kind: "lights",
          lights: [
            { device: "desk", capability: "light" },
            { device: "shelf", capability: "light" },
          ],
        },
        to: "brightenWhileHeld",
      },
    });
  });

  it("leave out a light that went, and go with the last of them", async () => {
    const home = startableHome({
      devices: [dimmer(), lamp("desk"), lamp("shelf")],
    });
    await home.start();
    await home.call(choosePress, {
      device: "dimmer",
      action: "up_hold",
      choice: someLights(["desk", "shelf"]),
    });

    await home.removeDevice("shelf");
    expect(
      (await home.call(listPresses, { device: "dimmer" })).presses.find(
        (press) => press.action === "up_hold",
      )?.choice,
    ).toEqual(someLights(["desk"]));

    await home.removeDevice("desk");
    expect(
      (await home.call(listPresses, { device: "dimmer" })).presses.find(
        (press) => press.action === "up_hold",
      )?.choice,
    ).toBeNull();
    expect(home.state.workflows.has("press:dimmer:up_hold")).toBe(false);
  });

  it("drops a chosen capability when its device still has other lights", async () => {
    const desk = lamp("desk");
    desk.capabilities.push({ ...desk.capabilities[0]!, id: "other" });
    const home = startableHome({ devices: [dimmer(), desk, lamp("shelf")] });
    await home.start();
    await home.call(choosePress, {
      device: "dimmer",
      action: "up_hold",
      choice: someLights(["desk", "shelf"]),
    });
    await home.changeDevice("desk", (device) => {
      device.capabilities = device.capabilities.filter(
        (each) => each.id !== "light",
      );
    });
    expect(
      (await home.call(listPresses, { device: "dimmer" })).presses.find(
        (press) => press.action === "up_hold",
      )?.choice,
    ).toEqual(someLights(["shelf"]));
  });

  it("drops a while-held choice when the action stops being a hold", async () => {
    const home = startableHome({ devices: [dimmer(), lamp("desk")] });
    await home.start();
    await home.call(choosePress, {
      device: "dimmer",
      action: "up_hold",
      choice: someLights(["desk"]),
    });
    await home.changeDevice("dimmer", (device) => {
      const button = device.capabilities[0]!;
      if (button.kind === "button") button.features.holds = [];
    });
    expect(
      (await home.call(listPresses, { device: "dimmer" })).presses.find(
        (press) => press.action === "up_hold",
      )?.choice,
    ).toBeNull();
  });

  it("must all be lights the home has", async () => {
    const home = startableHome({ devices: [dimmer(), lamp("desk")] });
    await home.start();

    await expect(
      home.call(choosePress, {
        device: "dimmer",
        action: "up_hold",
        choice: someLights(["desk", "gone"]),
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

it("refuses brightening while held for a press that is not a hold", async () => {
  const home = startableHome({ devices: [dimmer(), lamp("desk")] });
  await home.start();

  await expect(
    home.call(choosePress, {
      device: "dimmer",
      action: "up_press",
      choice: { ...roomToggle, to: "brightenWhileHeld" },
    }),
  ).rejects.toMatchObject({ code: "conflict" });
});

describe("presses while a permission is off", () => {
  it("keeps choices when permission is lost while a sync reads devices", async () => {
    const home = startableHome({ devices: [remote()] });
    await home.start();
    await home.call(choosePress, {
      device: "remote",
      action: "single",
      choice: homeOff,
    });

    const hold = home.holdDevices();
    const syncing = home.grant("devices.read:switch", false);
    await hold.reached;
    const pausing = home.grant("devices.read:button", false);
    hold.release();
    await Promise.all([syncing, pausing]);

    expect([...home.state.workflows.keys()]).toEqual([]);
    await home.grant("devices.read:button", true);
    expect(
      (await home.call(listPresses, { device: "remote" })).presses[0]?.choice,
    ).toEqual(homeOff);
  });

  it("pause while remotes are out of sight, and keep what the household chose", async () => {
    const home = startableHome({ devices: [remote()] });
    await home.start();
    await home.call(choosePress, {
      device: "remote",
      action: "single",
      choice: roomToggle,
    });
    expect(home.state.workflows.has("press:remote:single")).toBe(true);
    const db = drizzle(async (sql, params, method) => {
      const { rows } = await home.storage.query({ sql, params, method });
      return { rows: rows as unknown[] };
    });

    await home.grant("devices.read:button", false);
    expect([...home.state.workflows.keys()]).toEqual([]);
    expect((await readPresses(db, "remote")).get("single")).toEqual(roomToggle);

    await home.grant("devices.read:button", true);
    expect(home.state.workflows.has("press:remote:single")).toBe(true);
  });

  it("pause while the lights they name are out of sight, keeping every chosen light", async () => {
    const home = startableHome({
      devices: [dimmer(), lamp("desk"), lamp("shelf")],
    });
    await home.start();
    const someLights = {
      kind: "lights" as const,
      place: {
        kind: "lights" as const,
        lights: [
          { device: "desk", capability: "light" },
          { device: "shelf", capability: "light" },
        ],
      },
      to: "brightenWhileHeld" as const,
    };
    await home.call(choosePress, {
      device: "dimmer",
      action: "up_hold",
      choice: someLights,
    });

    await home.grant("devices.control:light", false);
    expect([...home.state.workflows.keys()]).toEqual([]);

    await home.grant("devices.control:light", true);
    expect(
      (await home.call(listPresses, { device: "dimmer" })).presses.find(
        (press) => press.action === "up_hold",
      )?.choice,
    ).toEqual(someLights);
    expect(home.state.workflows.has("press:dimmer:up_hold")).toBe(true);
  });

  it("keep every choice when the grants changed and back while a sync read the remotes", async () => {
    const home = startableHome({ devices: [remote()] });
    await home.start();
    await home.call(choosePress, {
      device: "remote",
      action: "single",
      choice: roomToggle,
    });
    const db = drizzle(async (sql, params, method) => {
      const { rows } = await home.storage.query({ sql, params, method });
      return { rows: rows as unknown[] };
    });

    // Remotes went out of sight and came back while the read ran: the
    // grants are as they were, but the read showed no remote.
    home.state.readDevices = () => {
      home.state.readDevices = null;
      home.state.revision += 2;
      return [];
    };
    await syncPresses(home.context());

    expect((await readPresses(db, "remote")).get("single")).toEqual(roomToggle);
  });

  it("are left as they are without Moods' own automations", async () => {
    const home = startableHome({ devices: [remote()] });
    await home.start();
    await home.call(choosePress, {
      device: "remote",
      action: "single",
      choice: roomToggle,
    });

    await home.grant("workflows.manage", false);
    expect(home.state.workflows.has("press:remote:single")).toBe(true);
  });
});

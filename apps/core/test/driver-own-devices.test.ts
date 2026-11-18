import {
  defineApp,
  type AppContext,
  type CoreEvent,
  type DeviceInfo,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { createReadSnapshot } from "../src/app-host/snapshot.js";
import { lampsCore, settled } from "./devices-support.js";
import { get, post } from "./support.js";

// A driver reads the devices it brings whole, every part and one Sanctum
// can't use too, with the key it registered each by, in lists and live
// updates, without a read permission, and never another driver's or their
// keys. Its pages see its own devices whole too, though not their keys.

function ownDriver() {
  const heard: CoreEvent[] = [];
  let context!: AppContext;
  const app = defineApp({
    id: "test.own",
    name: "Own",
    version: "0.1.0",
    core: "^2.0.0",
    permissions: [
      { id: "devices.register", reason: "For the test.", needed: true },
    ],
    actions: [],
    events: [],
    provides: {
      devicePages: [{ id: "own.status", title: "Status", devices: "own" }],
    },
    async start(ctx) {
      context = ctx;
      await ctx.devices.register({
        key: "aa:bb",
        name: "Hall lamp",
        manufacturer: null,
        model: null,
        type: "light",
        capabilities: [{ id: "light", kind: "light" }],
      });
      // One whose parts Sanctum can't use.
      await ctx.devices.register({
        key: "cc:dd",
        name: "Hall display",
        manufacturer: null,
        model: null,
        type: "unknown",
        capabilities: [],
      });
      await ctx.events.on("device.changed", async (event) => {
        heard.push(event);
      });
      await ctx.events.on("device.removed", async (event) => {
        heard.push(event);
      });
    },
    driver: { async command() {} },
  });
  return { app, heard, ctx: () => context };
}

async function owning() {
  const own = ownDriver();
  const home = await lampsCore({ apps: [{ app: own.app, origin: "system" }] });
  const listed = await own.ctx().devices.list();
  const idOf = (key: string) => listed.find((device) => device.key === key)!.id;
  return { ...home, ...own, lampHere: idOf("aa:bb"), display: idOf("cc:dd") };
}

const byName = (devices: DeviceInfo[]) =>
  devices
    .map(({ driverName, key, capabilities }) => ({
      driverName,
      key,
      parts: capabilities.map((each) => each.id),
    }))
    .sort((a, b) => a.driverName.localeCompare(b.driverName));

describe("a driver's own devices", () => {
  it("keep their registration keys in a startup snapshot after a device is removed", async () => {
    const { core, maya, lampHere } = await owning();
    const snapshot = createReadSnapshot(core);

    await post(
      core,
      "/api/devices/remove",
      { id: lampHere, force: true },
      maya,
    );

    expect(snapshot.devices.get(lampHere)).not.toBeNull();
    expect(snapshot.devices.keysOf("test.own").get(lampHere)).toBe("aa:bb");
    snapshot.release();
    expect(snapshot.devices.get(lampHere)).toBeNull();
    expect(snapshot.devices.keysOf("test.own").has(lampHere)).toBe(false);
  });

  it("are listed whole, with the keys it registered them by, and no one else's", async () => {
    const { ctx, display } = await owning();

    expect(byName(await ctx().devices.list())).toEqual([
      { driverName: "Hall display", key: "cc:dd", parts: [] },
      { driverName: "Hall lamp", key: "aa:bb", parts: ["light"] },
    ]);
    expect(await ctx().devices.state(display)).toMatchObject({
      key: "cc:dd",
      capabilities: [],
    });
  });

  it("are heard of as they change, with their keys, and another driver's aren't", async () => {
    const { core, maya, heard, lampHere, lamp } = await owning();

    await post(
      core,
      "/api/devices/update",
      { id: lampHere, name: "Porch lamp" },
      maya,
    );
    await post(
      core,
      "/api/devices/update",
      { id: lamp, name: "Desk lamp" },
      maya,
    );
    await settled();

    await expect
      .poll(() => heard.map((event) => "device" in event && event.device.name))
      .toEqual(["Porch lamp"]);
    expect(heard[0]).toMatchObject({
      name: "device.changed",
      device: { key: "aa:bb" },
      before: { key: "aa:bb", driverName: "Hall lamp" },
    });

    // It can't take it off its network, so it's forgotten by force.
    await post(
      core,
      "/api/devices/remove",
      { id: lampHere, force: true },
      maya,
    );
    await expect
      .poll(() => heard.at(-1))
      .toMatchObject({ name: "device.removed", device: { key: "aa:bb" } });
  });

  it("are whole for its pages, though not their keys, and other clients never see a key", async () => {
    const { core, maya, lampHere, display } = await owning();

    const forPage = await get(core, "/api/devices", {
      token: maya.token,
      headers: { "x-sanctum-app": "test.own" },
    });
    const seen = forPage.json() as DeviceInfo[];
    expect(seen.map((device) => device.id).sort()).toEqual(
      [lampHere, display].sort(),
    );
    expect(seen.some((device) => "key" in device)).toBe(false);

    const forPanel = await get(core, "/api/devices", {
      token: maya.token,
      headers: { "x-sanctum-app": "test.panel" },
    });
    expect(
      (forPanel.json() as DeviceInfo[]).map((device) => device.id),
    ).toContain(lampHere);
    const shell = (
      await get(core, "/api/devices", maya)
    ).json() as DeviceInfo[];
    expect(
      [...shell, ...(forPanel.json() as DeviceInfo[])].some(
        (device) => "key" in device,
      ),
    ).toBe(false);
  });

  it("list its page among the app's, for its devices alone", async () => {
    const { core, maya } = await owning();

    const apps = (await get(core, "/api/apps", maya)).json() as {
      id: string;
      provides: { devicePages: unknown[] };
    }[];

    expect(
      apps.find((each) => each.id === "test.own")!.provides.devicePages,
    ).toEqual([
      { id: "own.status", title: "Status", kinds: [], devices: "own" },
    ]);
  });
});

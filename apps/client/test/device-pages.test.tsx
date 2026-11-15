import type { AppInfo, DeviceInfo } from "@meetsanctum/app-sdk";
import type { AppClient } from "@meetsanctum/ui-sdk";
import { describe, expect, it } from "vitest";

import type { HostedApp } from "../src/apps";
import { devicePages } from "../src/device-detail";
import { pressesApp } from "./device-detail-app-fixtures";
import { lamp, remote } from "./device-detail-fixtures";

// The pages a device's detail shows: those apps add for its kinds, with what
// each app may read of it, and a driver's pages on its own devices alone,
// with all of each.

function ownApp(): HostedApp {
  const info: AppInfo = {
    id: "sanctum.example",
    name: "Example",
    version: "0.1.0",
    icon: null,
    pages: [],
    permissions: ["devices.register"],
    requests: [],
    state: "running",
    settings: null,
    provides: {
      entities: [],
      widgets: [],
      roomSections: [],
      devicePages: [
        { id: "example.status", title: "Status", kinds: [], devices: "own" },
      ],
    },
  };
  return {
    info,
    ui: {
      id: info.id,
      version: info.version,
      pages: {},
      devicePages: { "example.status": () => null },
    },
    client: { app: info } as AppClient,
  };
}

const theirs: DeviceInfo = { ...lamp, driver: "sanctum.example" };
const pagesOf = (device: DeviceInfo, apps: HostedApp[]) =>
  devicePages(
    apps,
    device,
    device.capabilities.map((each) => each.kind),
  ).map(({ id, device }) => ({ id, parts: device.capabilities.length }));

describe("a device's detail", () => {
  it("shows a driver's own page on the devices it brings, whole", () => {
    expect(pagesOf(theirs, [ownApp()])).toEqual([
      { id: "example.status", parts: 1 },
    ]);
    expect(pagesOf(lamp, [ownApp()])).toEqual([]);
  });

  it("shows another app's page for the kinds it names, with what it may read", () => {
    const apps = [pressesApp(["devices.read:button"]), ownApp()];

    expect(pagesOf(remote, apps)).toEqual([{ id: "test.presses", parts: 1 }]);
    expect(pagesOf(lamp, apps)).toEqual([]);
  });
});

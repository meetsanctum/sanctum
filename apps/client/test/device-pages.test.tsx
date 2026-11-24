// @vitest-environment jsdom
import type { AppInfo, DeviceInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed, type AppClient } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { HostedApp } from "../src/apps";
import { coreJson } from "../src/core-fetch";
import { DeviceDetail, devicePages } from "../src/device-detail";
import { forgetPageTicket } from "../src/frames/page-ticket";
import { useDevices } from "../src/use-devices";
import { devicePageAnswer, pressesApp } from "./device-detail-app-fixtures";
import { kettle, lamp, places, remote } from "./device-detail-fixtures";

vi.mock("../src/core-fetch", () => ({
  coreJson: vi.fn(),
  currentCredential: () => ({ token: "client" }),
}));

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
  return { info, client: { app: info } as AppClient };
}

const theirs: DeviceInfo = { ...lamp, driver: "sanctum.example" };
const pagesOf = (device: DeviceInfo, apps: HostedApp[]) =>
  devicePages(apps, device).map(({ id, device }) => ({
    id,
    parts: device.capabilities.length,
  }));

describe("a device's detail", () => {
  it("gives a driver's kind page its own device whole", () => {
    const app = ownApp();
    app.info.permissions.push("devices.read:button");
    app.info.provides.devicePages = [
      { id: "example.status", title: "Status", kinds: ["button"] },
    ];
    const device = {
      ...remote,
      driver: app.info.id,
      capabilities: [...remote.capabilities, ...kettle.capabilities],
    };

    expect(pagesOf(device, [app])).toEqual([
      { id: "example.status", parts: 2 },
    ]);
  });

  it("narrows a driver's own page when registration permission is revoked", () => {
    const app = ownApp();
    app.info.permissions = [];

    expect(pagesOf(theirs, [app])).toEqual([
      { id: "example.status", parts: 0 },
    ]);
  });

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

  it("shows a driver's own page for a device with no capabilities, in its frame, before Activity", async () => {
    forgetPageTicket();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    const device: DeviceInfo = {
      ...theirs,
      id: "display",
      name: "Hall display",
      type: "unknown",
      capabilities: [],
    };
    const live = createLiveFeed();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    vi.mocked(coreJson).mockImplementation(async (path) => {
      const page = devicePageAnswer(path, "sanctum.example");
      if (page) return page;
      if (path === "/api/devices") return [device];
      if (path === "/api/places") return places;
      if (path.startsWith("/api/activity?"))
        return { entries: [], more: false };
      throw new Error(`Unexpected request: ${path}`);
    });
    const app = ownApp();
    function Harness() {
      const devices = useDevices(live);
      return (
        <DeviceDetail
          container={container}
          tileKey="display/"
          open
          isCovering={false}
          devices={devices}
          apps={[app]}
          live={live}
          home={{
            name: "Home",
            devices: undefined,
            add: vi.fn(),
            remove: vi.fn(),
            order: vi.fn(),
          }}
          onClose={vi.fn()}
          onCovering={vi.fn()}
          onShowActivity={vi.fn()}
          onOpenAppSettings={vi.fn()}
          onOpenStatus={vi.fn()}
        />
      );
    }
    try {
      await act(async () => {
        root.render(<Harness />);
      });
      await act(async () => {
        live.refresh();
      });

      expect(
        container
          .querySelector('[role="dialog"] iframe[title="Example: Status"]')
          ?.getAttribute("src"),
      ).toContain("/pages/page_ticket/apps/sanctum.example/page/");
      expect(
        [...container.querySelectorAll('[role="tab"]')].map((tab) =>
          tab.getAttribute("aria-label"),
        ),
      ).toEqual(["Status, from Example", "Activity"]);
    } finally {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    }
  });
});

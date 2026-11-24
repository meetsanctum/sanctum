// @vitest-environment jsdom
import type { AppInfo, StaticManifest } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { listedApps } from "../src/apps-page";
import { coreJson } from "../src/core-fetch";
import { appBackdrop, DefaultAppPage } from "../src/default-app-page";

// The page the shell draws for an app that brings none of its own: its name
// and version over its colours, and what it does, with Show devices for a
// driver.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const example: AppInfo = {
  id: "sanctum.example",
  name: "Example Devices",
  version: "0.3.1",
  icon: { glyph: "tv", color: "graphite" },
  pages: [],
  permissions: [],
  requests: [],
  state: "running",
  settings: null,
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
};

const manifest = (driver: boolean) =>
  ({
    id: example.id,
    summary: "Brings your example devices into your home.",
    driver: driver ? { hooks: [] } : null,
  }) as unknown as StaticManifest;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.mocked(coreJson).mockReset();
});

async function show(app: AppInfo, driver: boolean) {
  vi.mocked(coreJson).mockResolvedValue(manifest(driver));
  const openDevices = vi.fn();
  await act(async () => {
    root.render(
      <DefaultAppPage
        app={app}
        deviceCount={0}
        openDevices={openDevices}
        openSettings={vi.fn()}
        openStatus={vi.fn()}
      />,
    );
  });
  return { openDevices };
}

const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (each) => each.textContent === name,
  );

describe("an app's default page", () => {
  it("names the app and its version, with Look for updates dimmed", async () => {
    await show(example, true);
    expect(container.querySelector("h1")?.textContent).toBe("Example Devices");
    expect(container.textContent).toContain("Version 0.3.1");
    expect(button("Look for updates")?.disabled).toBe(true);
  });

  it("says what the app does, from its manifest", async () => {
    await show(example, true);
    expect(coreJson).toHaveBeenCalledWith("/api/apps/sanctum.example/manifest");
    expect(container.textContent).toContain(
      "Brings your example devices into your home.",
    );
  });

  it("opens the home's devices from Show devices, for an app that brings them", async () => {
    const { openDevices } = await show(example, true);
    await act(async () => button("Show devices")?.click());
    expect(openDevices).toHaveBeenCalledOnce();
  });

  it("has no Show devices for an app that brings none", async () => {
    await show(example, false);
    expect(button("Show devices")).toBeUndefined();
  });

  it("says so while the app isn't running", async () => {
    await show({ ...example, state: "stopped" }, true);
    expect(container.textContent).toContain("Example Devices isn't running");
    expect(button("Open Status")).toBeDefined();
  });
});

describe("its background", () => {
  it("runs through the app's own colours, darkest at the bottom left", () => {
    expect(
      appBackdrop({ ...example, backdrop: { from: "#0a5c7a", to: "#18bcf2" } }),
    ).toContain("linear-gradient(to top right, #0a5c7a, #18bcf2)");
  });

  it("takes the icon's colour where the app names none", () => {
    expect(appBackdrop(example)).toContain("var(--graphite)");
  });

  it("paints nothing but colours", () => {
    const backdrop = appBackdrop({
      ...example,
      backdrop: { from: "url(https://example.com/x)", to: "#18bcf2" },
    });
    expect(backdrop).not.toContain("url(");
    expect(backdrop).toContain("var(--graphite)");
  });
});

describe("Apps", () => {
  it("opens every installed app at its main page, its own or the default", () => {
    const show = vi.fn();
    const [listed] = listedApps([], [example], show);
    listed!.onOpen();
    expect(show).toHaveBeenCalledWith([
      { app: "sanctum.example", page: "main", params: {} },
    ]);
  });
});

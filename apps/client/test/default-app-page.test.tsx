// @vitest-environment jsdom
import type { AppInfo, StaticManifest } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
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

async function show(app: AppInfo) {
  const live = createLiveFeed();
  const openDevices = vi.fn();
  await act(async () => {
    root.render(
      <DefaultAppPage
        app={app}
        live={live}
        deviceCount={0}
        openDevices={openDevices}
        openSettings={vi.fn()}
        openStatus={vi.fn()}
      />,
    );
  });
  return { live, openDevices };
}

const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (each) => each.textContent === name,
  );

describe("an app's default page", () => {
  beforeEach(() => {
    vi.mocked(coreJson).mockResolvedValue(manifest(true));
  });

  it("names the app and its version, with Look for updates dimmed", async () => {
    await show(example);
    expect(container.querySelector("h1")?.textContent).toBe("Example Devices");
    expect(container.textContent).toContain("Version 0.3.1");
    expect(button("Look for updates")?.disabled).toBe(true);
  });

  it("says what the app does, from its manifest", async () => {
    await show(example);
    expect(coreJson).toHaveBeenCalledWith("/api/apps/sanctum.example/manifest");
    expect(container.textContent).toContain(
      "Brings your example devices into your home.",
    );
  });

  it("opens the home's devices from Show devices, for an app that brings them", async () => {
    const { openDevices } = await show(example);
    await act(async () => button("Show devices")?.click());
    expect(openDevices).toHaveBeenCalledOnce();
  });

  it("has no Show devices for an app that brings none", async () => {
    vi.mocked(coreJson).mockResolvedValue(manifest(false));
    await show(example);
    expect(button("Show devices")).toBeUndefined();
  });

  it("says so while the app isn't running", async () => {
    vi.mocked(coreJson).mockResolvedValue({ summary: null, driver: null });
    await show({ ...example, state: "stopped" });
    expect(container.textContent).toContain("Example Devices isn't running");
    expect(button("Open System")).toBeDefined();
    expect(container.textContent).not.toContain("What it does");
  });

  it("keeps the driver action when the manifest has an invalid summary", async () => {
    vi.mocked(coreJson).mockResolvedValue({
      ...manifest(true),
      summary: { text: "Description" },
    });
    await show(example);
    expect(container.textContent).toContain(example.name);
    expect(container.textContent).not.toContain("Description");
    expect(button("Show devices")).toBeDefined();
  });

  it("retries a failed manifest read on the shell's next refresh", async () => {
    vi.mocked(coreJson).mockRejectedValueOnce(new Error("Connection lost"));
    const { live } = await show(example);
    expect(button("Show devices")).toBeUndefined();

    await act(async () => live.refresh());
    expect(container.textContent).toContain(manifest(true).summary);
    expect(button("Show devices")).toBeDefined();

    await act(async () => live.refresh());
    expect(coreJson).toHaveBeenCalledTimes(2);
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

  it("falls back when the icon's colour is unknown", () => {
    const icon = {
      glyph: "tv",
      color: "unknown",
    } as unknown as AppInfo["icon"];
    expect(appBackdrop({ ...example, icon })).toContain("var(--graphite)");
  });

  it.each([
    { from: "#3e6ae1", to: "#18bcf2" },
    { from: "#0a5c7a", to: "#3E6AE1" },
  ])(
    "reserves the action colour when the backdrop is $from to $to",
    (backdrop) => {
      expect(appBackdrop({ ...example, backdrop })).toContain(
        "var(--graphite)",
      );
    },
  );

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

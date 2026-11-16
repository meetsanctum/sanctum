// @vitest-environment jsdom
import type { AppInfo } from "@meetsanctum/app-sdk";
import {
  createAppClient,
  createLiveFeed,
  type CoreBridge,
} from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostedApp } from "../src/apps";
import { AppFrame } from "../src/frames/app-frame";

// An app's page in its frame, as the shell shows it before and instead of
// the page: its name in the top bar, the loader after 0.4 s, and a notice
// when it doesn't open. The page never answers here.

const address = vi.hoisted(() => ({
  answer: () =>
    Promise.resolve({
      kit: { version: "0.1.1", bridge: 1, digest: "kit" },
      url: "about:blank",
    }) as Promise<unknown>,
  calls: 0,
}));
vi.mock("../src/frames/page-ticket", () => ({
  pageAddress: () => {
    address.calls++;
    return address.answer();
  },
  forgetPageTicket: vi.fn(),
}));

const info = (over: Partial<AppInfo> = {}): AppInfo => ({
  id: "sanctum.weather",
  name: "Weather",
  version: "0.3.0",
  icon: null,
  pages: ["main"],
  permissions: [],
  requests: [],
  state: "running",
  settings: null,
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
  ...over,
});

const hosted = (app: AppInfo): HostedApp => ({
  info: app,
  ui: { id: app.id, version: app.version, pages: {} },
  client: createAppClient(app, {
    json: vi.fn() as unknown as CoreBridge["json"],
    live: createLiveFeed(),
    ask: vi.fn(),
  }),
});

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  address.calls = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function show(options: { app?: AppInfo; isAway?: boolean } = {}) {
  await act(async () => {
    root.render(
      <AppFrame
        app={hosted(options.app ?? info())}
        page="main"
        params={{}}
        shown="1"
        open={() => {}}
        back={() => {}}
        openSettings={() => {}}
        mode="day"
        household={undefined}
        isAway={options.isAway ?? false}
      />,
    );
  });
}

const after = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

const text = () => container.textContent;
const frame = () => container.querySelector("iframe")!;

describe("an app's page in its frame", () => {
  it("shows the app's name, and the loader only after 0.4 s", async () => {
    await show();
    expect(container.querySelector("h1")?.textContent).toBe("Weather");
    expect(text()).not.toContain("Opening Weather");
    expect(frame().className).toContain("opacity-0");
    expect(frame().getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame().getAttribute("allow")).toBe("");
    await after(400);
    expect(text()).toContain("Opening Weather");
  });

  it("says it didn't open when it doesn't answer in 10 s, and tries again", async () => {
    await show();
    await after(9_999);
    expect(text()).not.toContain("didn't open");
    await after(1);
    expect(text()).toContain("Weather's page didn't open");
    expect(text()).toContain(
      "It didn't answer in time. What Weather adds to the home keeps working.",
    );
    expect(address.calls).toBe(1);
    const tryAgain = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    )!;
    await act(async () => tryAgain.click());
    expect(address.calls).toBe(2);
    expect(text()).not.toContain("didn't open");
  });

  it("says its files didn't load when the core has none", async () => {
    address.answer = () => Promise.reject(new Error("not_found"));
    await show();
    expect(text()).toContain("Weather's page didn't open");
    expect(text()).toContain("Its files didn't load.");
  });

  it("waits while the home is away", async () => {
    address.answer = () =>
      Promise.resolve({
        kit: { version: "0.1.1", bridge: 1, digest: "kit" },
        url: "about:blank",
      });
    await show({ isAway: true });
    await after(60_000);
    expect(text()).not.toContain("didn't open");
    await show({ isAway: false });
    await after(10_000);
    expect(text()).toContain("Weather's page didn't open");
  });

  it("leaves a paused app's notice to the shell", async () => {
    await show({ app: info({ state: "paused" }) });
    await after(60_000);
    expect(text()).not.toContain("didn't open");
  });
});

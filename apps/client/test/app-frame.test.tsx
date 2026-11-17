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
import { forgetPageTicket } from "../src/frames/page-ticket";

// An app's page in its frame, as the shell shows it before and instead of
// the page: its name in the top bar, the loader after 0.4 s, and a notice
// when it doesn't open. The page never answers here.

const address = vi.hoisted(() => ({
  answer: (): Promise<unknown> => Promise.resolve(),
  calls: 0,
  tickets: 0,
}));
vi.mock("../src/core-fetch", () => ({
  currentCredential: () => ({ token: "client" }),
  coreJson: (path: string) => {
    if (path === "/api/pages/ticket") {
      address.tickets++;
      return address.answer();
    }
    address.calls++;
    return Promise.resolve({ digest: "page" });
  },
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
  forgetPageTicket();
  address.calls = 0;
  address.tickets = 0;
  address.answer = () =>
    Promise.resolve({
      ticket: `page_ticket${address.tickets}`,
      expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60_000).toISOString(),
      kit: { version: "0.1.1", bridge: 1, digest: "kit" },
    });
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

async function show(
  options: { app?: AppInfo; isAway?: boolean; shown?: string } = {},
) {
  await act(async () => {
    root.render(
      <AppFrame
        app={hosted(options.app ?? info())}
        page="main"
        params={{}}
        shown={options.shown ?? "1"}
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

// The frame says hello as the kit would, and its end of the port.
function hello() {
  const target = frame().contentWindow!;
  const code = new URL(frame().src).hash.replace("#hello=", "");
  let port: MessagePort | undefined;
  vi.spyOn(target, "postMessage").mockImplementation(((
    _data: unknown,
    _to: string,
    ports: MessagePort[],
  ) => {
    port = ports[0];
  }) as typeof target.postMessage);
  window.dispatchEvent(
    Object.assign(new Event("message"), {
      data: { sanctum: "hello", code, bridge: 1 },
      source: target,
    }),
  );
  return port!;
}

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
    expect(frame().src).toContain("/pages/page_ticket1/");
    const tryAgain = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Try again",
    )!;
    await act(async () => tryAgain.click());
    expect(frame().src).toContain("/pages/page_ticket2/");
    expect(address.calls).toBe(2);
    expect(text()).not.toContain("didn't open");
  });

  it("opens a new frame with a full timeout when the app's version changes", async () => {
    await show();
    const previous = frame();
    await after(9_500);
    await show({ app: info({ version: "0.3.1" }) });
    expect(frame()).not.toBe(previous);
    expect(address.calls).toBe(2);
    await after(9_999);
    expect(text()).not.toContain("didn't open");
    await after(1);
    expect(text()).toContain("It didn't answer in time.");
  });

  it("shows the page's title, and the app's name again when another page shows", async () => {
    await show();
    const port = hello();
    port.postMessage({
      type: "bar",
      title: "Forecast",
      actions: [],
      revision: 1,
    });
    await vi.waitFor(() =>
      expect(container.querySelector("h1")?.textContent).toBe("Forecast"),
    );
    await show({ shown: "2" });
    expect(container.querySelector("h1")?.textContent).toBe("Weather");
    port.close();
  });

  it("gives a page that loads again a frame afresh, with a new code", async () => {
    await show();
    const first = frame();
    const code = new URL(first.src).hash;
    await act(async () => first.dispatchEvent(new Event("load")));
    expect(frame()).toBe(first);
    // Reloaded, or sent elsewhere, by its own code.
    await act(async () => first.dispatchEvent(new Event("load")));
    expect(address.calls).toBe(2);
    expect(frame()).not.toBe(first);
    expect(new URL(frame().src).hash).not.toBe(code);
  });

  it("names its address to the desktop app before it loads, and ends it after", async () => {
    const named: string[] = [];
    const ended: string[] = [];
    vi.stubGlobal("sanctumShell", {
      frames: {
        allow: async (url: string) => {
          named.push(url);
          // Not loaded yet: the frame waits for the app's answer.
          expect(
            container.querySelector("iframe")?.getAttribute("src"),
          ).toBeNull();
          return true;
        },
        end: async (url: string) => {
          ended.push(url);
        },
      },
    });
    await show();
    expect(named).toEqual([frame().src]);
    act(() => root.unmount());
    expect(ended).toEqual(named);
    root = createRoot(container);
  });

  it("doesn't load an address the desktop app refuses", async () => {
    vi.stubGlobal("sanctumShell", {
      frames: { allow: async () => false, end: async () => {} },
    });
    await show();
    expect(frame().getAttribute("src")).toBeNull();
    expect(text()).toContain("Its files didn't load.");
  });

  it("draws the page's actions in the top bar, and says which was pressed, at which revision", async () => {
    await show();
    const port = hello();
    const said: unknown[] = [];
    port.onmessage = (event) => said.push(event.data);
    port.postMessage({
      type: "bar",
      title: "Edit mood",
      actions: [
        { id: "cancel", label: "Cancel" },
        { id: "save", label: "Save", primary: true, disabled: true },
      ],
      revision: 3,
    });
    await vi.waitFor(() =>
      expect(container.querySelector("h1")?.textContent).toBe("Edit mood"),
    );
    const buttons = [...container.querySelectorAll("button")];
    const save = buttons.find((each) => each.textContent === "Save")!;
    expect(save.disabled).toBe(true);
    await act(async () =>
      buttons.find((each) => each.textContent === "Cancel")!.click(),
    );
    await vi.waitFor(() =>
      expect(said).toContainEqual({ type: "press", id: "cancel", revision: 3 }),
    );
    port.close();
  });

  it("says its files didn't load when the core has none", async () => {
    address.answer = () => Promise.reject(new Error("not_found"));
    await show();
    expect(text()).toContain("Weather's page didn't open");
    expect(text()).toContain("Its files didn't load.");
  });

  it("waits while the home is away", async () => {
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

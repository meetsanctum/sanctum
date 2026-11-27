// @vitest-environment jsdom
import type { AppInfo } from "@meetsanctum/app-sdk";
import {
  createAppClient,
  createLiveFeed,
  frameBridge,
  type CoreBridge,
  type ToFrame,
} from "@meetsanctum/ui-sdk";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostedApp } from "../src/apps";
import { CoreError } from "../src/core-fetch";
import { AppFrame } from "../src/frames/app-frame";
import { forgetPageTicket } from "../src/frames/page-ticket";

// An app's page in its frame, as the shell shows it before and instead of
// the page: its name in the top bar, the loader after 0.4 s, and a notice
// when it doesn't open. The page never answers here.

const address = vi.hoisted(() => ({
  answer: (): Promise<unknown> => Promise.resolve(),
  pages: (): Promise<unknown> => Promise.resolve({ digest: "page" }),
  calls: 0,
  tickets: 0,
}));
vi.mock("../src/core-fetch", async () => ({
  CoreError: (
    await vi.importActual<typeof import("../src/core-fetch")>(
      "../src/core-fetch",
    )
  ).CoreError,
  currentCredential: () => ({ token: "client" }),
  coreJson: (path: string) => {
    if (path === "/api/pages/ticket") {
      address.tickets++;
      return address.answer();
    }
    address.calls++;
    return address.pages();
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
  address.pages = () => Promise.resolve({ digest: "page" });
  address.answer = () =>
    Promise.resolve({
      ticket: `page_ticket${address.tickets}`,
      expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60_000).toISOString(),
      kit: { version: "0.1.2", bridge: frameBridge, digest: "kit" },
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
  delete document.documentElement.dataset.effects;
  delete document.documentElement.dataset.motion;
});

async function show(
  options: {
    app?: AppInfo;
    isAway?: boolean;
    shown?: string;
    household?: ComponentProps<typeof AppFrame>["household"];
  } = {},
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
        openDevice={() => {}}
        addDevices={() => {}}
        mode="day"
        household={options.household}
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
      data: { sanctum: "hello", code, bridge: frameBridge },
      source: target,
    }),
  );
  return port!;
}

describe("an app's page in its frame", () => {
  it("sends the home's zone and hours, so the page writes times as the home does", async () => {
    await show({
      household: {
        temperatureUnit: "celsius",
        timeZone: "Europe/Zurich",
        hourCycle: "12h",
      },
    });
    const port = hello();
    const said: ToFrame[] = [];
    port.onmessage = (event: MessageEvent<ToFrame>) => said.push(event.data);
    try {
      await vi.waitFor(() =>
        expect(said[0]).toMatchObject({
          type: "setup",
          context: { timeZone: "Europe/Zurich", hourCycle: "12h" },
        }),
      );
    } finally {
      port.close();
    }
  });

  it("sends the shell's effects and motion settings on setup and on separate changes", async () => {
    document.documentElement.dataset.effects = "reduced";
    document.documentElement.dataset.motion = "reduced";
    await show();
    const port = hello();
    const said: ToFrame[] = [];
    port.onmessage = (event: MessageEvent<ToFrame>) => said.push(event.data);
    try {
      await vi.waitFor(() =>
        expect(said[0]).toMatchObject({
          type: "setup",
          context: { effects: "reduced", motion: "reduced" },
        }),
      );
      await act(async () => {
        delete document.documentElement.dataset.effects;
      });
      await vi.waitFor(() =>
        expect(said).toContainEqual({
          type: "context",
          context: {
            mode: "day",
            effects: "regular",
            motion: "reduced",
            temperatureUnit: null,
            timeZone: null,
            hourCycle: null,
          },
        }),
      );
      await act(async () => {
        delete document.documentElement.dataset.motion;
      });
      await vi.waitFor(() =>
        expect(said).toContainEqual({
          type: "context",
          context: {
            mode: "day",
            effects: "regular",
            motion: "regular",
            temperatureUnit: null,
            timeZone: null,
            hourCycle: null,
          },
        }),
      );
    } finally {
      port.close();
    }
  });

  it("shows the app's name, and the page's sections only after 0.4 s", async () => {
    await show();
    expect(container.querySelector("h1")?.textContent).toBe("Weather");
    expect(text()).not.toContain("Opening Weather");
    expect(container.querySelector("[data-slot=skeleton]")).toBeNull();
    expect(frame().className).toContain("opacity-0");
    expect(frame().getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame().getAttribute("allow")).toBe("");
    await after(400);
    expect(text()).toContain("Opening Weather…");
    expect(container.querySelectorAll("[data-slot=skeleton]")).toHaveLength(4);
  });

  it("says it's taking longer than usual after 5 s, and goes once it's ready", async () => {
    await show();
    await after(4_999);
    expect(text()).not.toContain("taking longer");
    await after(1);
    expect(text()).toContain("Opening Weather is taking longer than usual.");
    const port = hello();
    port.postMessage({ type: "ready" });
    await vi.waitFor(() => expect(text()).not.toContain("taking longer"));
    expect(container.querySelector("[data-slot=skeleton]")).toBeNull();
    port.close();
  });

  it("says it didn't open when it doesn't answer in 10 s, and tries again", async () => {
    await show();
    await after(9_999);
    expect(text()).not.toContain("didn't open");
    await after(1);
    expect(container.querySelector("[role=alert]")?.textContent).toBe(
      "Weather's page didn't openWhat Weather adds to the home keeps working.Try again",
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
    expect(text()).toContain("Weather's page didn't open");
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
    expect(text()).toContain("Weather's page didn't open");
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

  it("removes the actions when their page stops working", async () => {
    await show();
    const port = hello();
    port.postMessage({
      type: "bar",
      title: "Edit mood",
      actions: [{ id: "save", label: "Save", primary: true }],
      revision: 1,
    });
    await vi.waitFor(() =>
      expect(container.querySelector("button")?.textContent).toBe("Save"),
    );
    port.postMessage({ type: "failed", reason: "stopped", message: "Broken" });
    await vi.waitFor(() => expect(text()).toContain("page stopped working"));
    expect(
      [...container.querySelectorAll("button")].map((each) => each.textContent),
    ).toEqual(["Try again"]);
    port.close();
  });

  it.each([1, frameBridge + 1])(
    "doesn't load a kit of bridge %i",
    async (bridge) => {
      address.answer = async () => ({
        ticket: "page_ticket1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        kit: { version: "0.1.2", bridge, digest: "kit" },
      });
      await show();
      expect(container.querySelector("iframe[src]")).toBeNull();
      expect(text()).toContain(
        bridge < frameBridge
          ? "This page needs a newer Sanctum"
          : "To open this page, update this app",
      );
      expect(text()).not.toContain("Try again");
    },
  );

  it.each([
    [
      "sanctum",
      "This page needs a newer Sanctum",
      "Update Sanctum to open it.",
    ],
    [
      "pages",
      "This page needs an update of Weather",
      "It was made for an older Sanctum.",
    ],
  ])(
    "says what pages that don't fit the home's kit need: %s",
    async (needs, title, line) => {
      address.pages = () =>
        Promise.reject(
          new CoreError(404, "not_found", { error: "not_found", needs }),
        );
      await show();
      expect(container.querySelector("iframe[src]")).toBeNull();
      expect(text()).toContain(title);
      expect(text()).toContain(line);
      expect(text()).toContain("What Weather adds to the home keeps working.");
    },
  );

  it.each(["sanctum", "pages", "bridge"])(
    "reads the home's kit afresh when reopening after a %s mismatch, keeping its ticket",
    async (needs) => {
      const current = { version: "0.1.2", bridge: frameBridge, digest: "kit" };
      const old = { version: "0.1.0", bridge: frameBridge - 1, digest: "old" };
      address.pages =
        needs === "bridge"
          ? () => Promise.resolve({ digest: "page", kit: old })
          : () =>
              Promise.reject(
                new CoreError(404, "not_found", { error: "not_found", needs }),
              );
      await show();
      expect(container.querySelector("iframe[src]")).toBeNull();
      expect(text()).toContain("This page needs");

      // The home and app have updated while another page was open: the
      // ticket other frames hold stays, and the kit is the one served now.
      address.pages = () =>
        Promise.resolve({ digest: "updated", kit: current });
      await show({ shown: "2" });
      expect(frame().src).toContain("/pages/page_ticket1/");
      expect(frame().src).toContain("/updated/");
      expect(address.tickets).toBe(1);
      expect(text()).not.toContain("This page needs");
    },
  );

  it("opens afresh on a new build of the same version, as a saved change makes", async () => {
    await show({ app: info({ build: "0.3.0+aaaa" }) });
    const first = frame();
    await show({ app: info({ build: "0.3.0+bbbb" }) });
    expect(address.calls).toBe(2);
    expect(frame()).not.toBe(first);
  });

  it("says it didn't open when the core has no files for it", async () => {
    address.answer = () => Promise.reject(new Error("not_found"));
    await show();
    expect(text()).toContain("Weather's page didn't open");
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

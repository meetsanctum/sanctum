// @vitest-environment jsdom
import type {
  AppInfo,
  DashboardInfo,
  EntityInfo,
  LiveMessage,
  WidgetContent,
} from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import type { CoreStatus } from "../src/core-status";
import { Home } from "../src/Home";
import type { StoredHost } from "../src/shell";
import { light } from "./settings-devices-fixtures";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
  currentCredential: () => null,
}));
vi.mock("../src/auth/session", () => ({
  followHost: (host: StoredHost, found: (url: string) => void) => {
    found(host.url);
    return () => {};
  },
}));
const coreStatus = vi.hoisted(() => ({
  publish: (_status: CoreStatus) => {},
}));
vi.mock("../src/core-status", () => ({
  startCoreStatusPolling: (onStatus: (status: CoreStatus) => void) => {
    coreStatus.publish = onStatus;
    onStatus({ state: "online", version: "dev" });
    return { stop() {}, checkNow() {} };
  },
}));
// What the core pushes over the live socket.
const socket = vi.hoisted(() => ({
  push: (_message: LiveMessage) => {},
}));
vi.mock("../src/live", () => ({
  connectLive: (
    _onState: unknown,
    onMessage: (message: LiveMessage) => void,
  ) => {
    socket.push = onMessage;
    return { stop() {}, retryNow() {} };
  },
}));

const moods: AppInfo = {
  id: "sanctum.moods",
  name: "Moods",
  version: "0.1.0",
  icon: { glyph: "sparkles", color: "ember" },
  pages: ["room", "category"],
  permissions: ["places.read", "devices.control:light"],
  requests: [],
  state: "running",
  settings: null,
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
};
const weather: AppInfo = {
  id: "sanctum.weather",
  name: "Weather",
  version: "0.2.0",
  icon: { glyph: "cloud-sun", color: "sky" },
  pages: ["main"],
  permissions: ["places.location"],
  requests: [],
  state: "running",
  settings: null,
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
};
// An app whose own page opens its preferences.
const naturalLight: AppInfo = {
  id: "sanctum.natural-light",
  name: "Natural light",
  version: "0.1.0",
  icon: { glyph: "sun", color: "sun" },
  pages: ["main"],
  permissions: ["places.location", "devices.control:light"],
  requests: [],
  state: "running",
  settings: {
    type: "object",
    properties: {
      shape: {
        type: "string",
        title: "Curve",
        enum: ["balanced", "early_riser"],
        options: { balanced: "Balanced", early_riser: "Early riser" },
        default: "balanced",
      },
    },
  },
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
};
const host: StoredHost = {
  hostId: "host",
  homeId: "home",
  name: "Home",
  url: "http://localhost:4100",
  clientId: "client",
  token: "test-token",
  kind: "personal",
  pin: null,
};

const homeDashboard: DashboardInfo = {
  id: "d-home",
  name: "Home",
  background: "mocha",
  kind: "home",
  devices: [],
};
const night: DashboardInfo = {
  id: "d-night",
  name: "Night",
  background: "mocha",
  kind: "custom",
};

let root: Root;
let container: HTMLDivElement;
let installed: AppInfo[];
let dashboards: DashboardInfo[];
// What the apps show, which the shell reads by app and type.
let entities: EntityInfo[];
let devices: unknown[];
// The household's pinned apps.
let pins: string[];

function renderHome() {
  root.render(
    <Home
      host={host}
      onHostMoved={() => {}}
      onSignedOut={() => {}}
      onCertificateChanged={() => {}}
    />,
  );
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  installed = [moods];
  dashboards = [homeDashboard];
  entities = [];
  devices = [];
  pins = [];
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init) => {
    if (path.startsWith("/api/entities?")) {
      const query = new URLSearchParams(path.slice(path.indexOf("?")));
      return entities.filter(
        (entity) =>
          entity.app === query.get("app") && entity.type === query.get("type"),
      );
    }
    switch (path) {
      case "/api/auth/me":
        return { client: { kind: "shared" }, person: null };
      case "/api/apps":
        return installed;
      case "/api/dashboards":
        return dashboards;
      case "/api/dashboards/update": {
        const { id, name } = init!.json as { id: string; name: string };
        dashboards = dashboards.map((dashboard) =>
          dashboard.id === id ? { ...dashboard, name } : dashboard,
        );
        return dashboards.find((dashboard) => dashboard.id === id);
      }
      case "/api/pins":
        return pins;
      case "/api/pins/update":
        pins = (init!.json as { apps: string[] }).apps;
        return pins;
      case "/api/devices":
        return devices;
      case "/api/entities":
        return [];
      case "/api/apps/sanctum.natural-light/settings":
        return { shape: "balanced" };
      case "/api/apps/sanctum.natural-light/actions/naturalLight.preview":
        return null;
      case "/api/places":
        return {
          home: {
            name: "Our home",
            timeZone: "UTC",
            temperatureUnit: "celsius",
          },
          rooms: [{ id: "kitchen", name: "Kitchen", floorId: null }],
          floors: [],
          zones: [],
        };
      default:
        throw new Error(`Unexpected request: ${path}`);
    }
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => renderHome());
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function refresh() {
  await act(async () => window.dispatchEvent(new Event("focus")));
}

// An app's page carries its title in the top bar; a room's page and a
// dashboard in the page.
const pageTitle = () =>
  (container.querySelector(".top-bar h1") ?? container.querySelector("main h1"))
    ?.textContent;

const backShown = () =>
  [...container.querySelectorAll("button")].some(
    (button) => button.textContent === "Back",
  );

// The places in the docked sidebar, after its pins.
async function showSidebar() {
  return [
    ...container.querySelectorAll<HTMLButtonElement>(
      "aside.sidebar-column nav > button",
    ),
  ];
}

// A place in the sidebar.
async function choose(name: string) {
  const places = await showSidebar();
  await act(async () => {
    places.find((button) => button.textContent === name)!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

// The kitchen's page, from the rooms in the sidebar, which are the shell's.
async function openKitchen() {
  await choose("Kitchen");
  expect(pageTitle()).toBe("Kitchen");
}

const title = () => container.querySelector("header")?.textContent;

// Apps, from the sidebar's last tile, and the app pressed there.
async function openFromOverview(name: string) {
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('aside button[aria-label="Apps"]')!
      .click();
  });
  const apps = [
    ...container.querySelectorAll<HTMLButtonElement>("main li button"),
  ];
  await act(async () => {
    apps.find((button) => button.textContent === name)!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  return apps.map((button) => button.textContent);
}

describe("navigation", () => {
  it("opens a room from the sidebar, named in the top bar, with no Back", async () => {
    await openKitchen();
    expect(backShown()).toBe(false);
    expect(container.querySelector(".top-bar h1")?.textContent).toBe("Kitchen");
    expect(container.querySelector("main h1")).toBeNull();
  });

  it("shows the page on the dashboard's background, with no card around it", async () => {
    const main = container.querySelector("main")!;
    expect(main.className).toBe("page");
    expect(container.querySelector("header")?.textContent).toBe("Home");
  });

  it("opens Apps from the sidebar's last tile, as a page in the device's mode", async () => {
    const tile = container.querySelector<HTMLButtonElement>(
      'aside button[aria-label="Apps"]',
    )!;
    await act(async () => tile.click());
    expect(pageTitle()).toBe("Apps");
    expect(container.querySelector("main")!.className).toBe("page app-page");
    expect(tile.getAttribute("aria-current")).toBe("page");
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it("lists Automations and Settings in the overview, not Moods, which has no page of its own", async () => {
    expect(await openFromOverview("Settings")).toEqual([
      "Automations",
      "Settings",
    ]);
    expect(pageTitle()).toBe("Settings");
    expect(container.querySelector("main")?.textContent).toContain(
      "MoodsVersion 0.1.0",
    );
    expect(container.querySelector("main")?.textContent).toContain(
      "Shared by the household",
    );
    expect(backShown()).toBe(false);
  });
});

describe("an app's preferences", () => {
  const done = async () => {
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>(".top-bar button")]
        .find((button) => button.textContent === "Done")!
        .click();
    });
  };

  it("open from Settings → Apps, and Done beside their title returns to Settings", async () => {
    await openFromOverview("Settings");
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("main li button")]
        .find((button) => button.textContent?.startsWith("Moods"))!
        .click();
    });

    expect(pageTitle()).toBe("Moods settings");
    expect(backShown()).toBe(false);
    await done();
    expect(pageTitle()).toBe("Settings");
  });

  it("open from the same button at the end of the bar on every app page, never on Sanctum's own", async () => {
    installed = [moods, weather];
    await refresh();
    const gear = (name: string) =>
      container.querySelector<HTMLButtonElement>(
        `.top-bar button[aria-label="${name} settings"]`,
      );

    await openFromOverview("Weather");
    expect(gear("Weather")).not.toBeNull();
    // Last in the bar, after the page's own buttons.
    expect([...container.querySelectorAll(".top-bar button")].at(-1)).toBe(
      gear("Weather"),
    );
    await act(async () => gear("Weather")!.click());
    expect(pageTitle()).toBe("Weather settings");
    expect(gear("Weather")).toBeNull();

    await openFromOverview("Settings");
    expect(
      container.querySelector(".top-bar [aria-label$=' settings']"),
    ).toBeNull();
  });

  it("open from the app's own page, and Done returns to it", async () => {
    installed = [moods, naturalLight];
    await refresh();
    await openFromOverview("Natural light");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Natural light settings"]',
        )!
        .click();
    });

    expect(container.querySelector("main")?.textContent).toContain(
      "Version 0.1.0",
    );
    expect(container.querySelector("main")?.textContent).toContain(
      "CurveBalanced",
    );
    await done();
    expect(
      container.querySelector('button[aria-label="Natural light settings"]'),
    ).not.toBeNull();
  });

  it("go when their app does", async () => {
    installed = [moods, weather];
    await refresh();
    await openFromOverview("Settings");
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("main li button")]
        .find((button) => button.textContent?.startsWith("Weather"))!
        .click();
    });
    installed = [moods];
    await refresh();

    expect(pageTitle()).toBe("Settings");
  });
});

describe("the home's installed apps", () => {
  it("keeps an open page when the app list has not changed", async () => {
    await openKitchen();
    await refresh();
    expect(pageTitle()).toBe("Kitchen");
  });

  it("keeps a room's page when Moods goes: rooms are the shell's", async () => {
    await openKitchen();
    installed = [];
    await refresh();
    expect(pageTitle()).toBe("Kitchen");
  });

  it.each([
    { name: "app", apps: [moods] },
    { name: "page", apps: [moods, { ...weather, pages: [] }] },
  ])("returns home when the current $name disappears", async ({ apps }) => {
    installed = [moods, weather];
    await refresh();
    await openFromOverview("Weather");
    expect(pageTitle()).toBe("Weather");
    installed = apps;
    await refresh();
    expect(pageTitle()).toBe("Home");
    expect(container.querySelector("header")?.textContent).toBe("Home");
    expect(backShown()).toBe(false);
  });

  it("ignores an older app list that arrives after a newer refresh", async () => {
    let resolve!: (apps: AppInfo[]) => void;
    const pending = new Promise<AppInfo[]>((done) => {
      resolve = done;
    });
    // A focus refresh asks for the identity first and then the apps.
    vi.mocked(coreJson)
      .mockResolvedValueOnce({ client: { kind: "shared" }, person: null })
      .mockReturnValueOnce(pending);
    await refresh();
    installed = [];
    await refresh();
    await act(async () => {
      resolve([moods, weather]);
      await pending;
    });
    // Weather stays gone from Apps.
    expect(await openFromOverview("Settings")).toEqual([
      "Automations",
      "Settings",
    ]);
  });
});

describe("apps' widgets", () => {
  const card = (content: WidgetContent): EntityInfo => ({
    app: "sanctum.weather",
    key: "home",
    type: "weather.card",
    name: "Weather",
    state: content,
    updatedAt: "2026-11-03T09:00:00.000Z",
  });
  const withCard: AppInfo = {
    ...weather,
    provides: {
      ...weather.provides,
      widgets: [
        { id: "weather.card", title: "Weather", size: { columns: 4, rows: 4 } },
      ],
    },
  };
  const cardOnHome = () =>
    container.querySelector<HTMLElement>("main article[aria-labelledby]");
  // A home with a device shows its dashboard, not how to set it up.
  beforeEach(() => {
    devices = [light("lamp", "Lamp")];
  });

  it("draws each card on Home after the rooms, from what its app shows, and follows it", async () => {
    installed = [moods, withCard];
    entities = [
      card({
        blocks: [
          { kind: "headline", icon: "cloud-sun", value: { temperature: 8.2 } },
          { kind: "note", text: "No forecast yet." },
        ],
      }),
    ];
    await refresh();

    const shown = cardOnHome()!;
    expect(shown.textContent).toBe("Weather8°No forecast yet.");
    expect(shown.querySelector("h2")?.style.color).toBe("var(--sky-text)");
    // Last on Home, after the rooms.
    expect(shown.parentElement).toBe(
      container.querySelector("main")?.lastElementChild,
    );

    await act(async () =>
      socket.push({
        type: "entity",
        app: "sanctum.weather",
        key: "home",
        entity: card({ blocks: [{ kind: "note", text: "Rain soon." }] }),
        was: "weather.card",
      }),
    );
    expect(cardOnHome()?.textContent).toBe("WeatherRain soon.");

    await act(async () =>
      socket.push({
        type: "entity",
        app: "sanctum.weather",
        key: "home",
        entity: null,
        was: "weather.card",
      }),
    );
    expect(cardOnHome()).toBeNull();
  });

  it("runs a card's check through the gate as whoever pressed it", async () => {
    installed = [withCard];
    entities = [
      card({
        blocks: [
          {
            kind: "rows",
            items: [
              {
                text: "Umbrella",
                check: {
                  checked: false,
                  action: "weather.remind",
                  input: { thing: "umbrella" },
                },
              },
            ],
          },
        ],
      }),
    ];
    await refresh();

    await act(async () =>
      cardOnHome()!
        .querySelector<HTMLButtonElement>('[role="checkbox"]')!
        .click(),
    );

    expect(coreJson).toHaveBeenCalledWith(
      "/api/apps/sanctum.weather/actions/weather.remind",
      { method: "POST", json: { thing: "umbrella" } },
    );
  });

  it("shows none for an app that has shown no card", async () => {
    installed = [moods, withCard];
    await refresh();

    expect(cardOnHome()).toBeNull();
  });
});

describe("the home's dashboards", () => {
  beforeEach(async () => {
    dashboards = [homeDashboard, night];
    await refresh();
  });

  const dashboardItems = async () =>
    (await showSidebar()).slice(0, dashboards.length);

  async function openDashboardMenu() {
    await act(async () =>
      container
        .querySelector('button[aria-label="Night: more"]')!
        .dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
        ),
    );
  }

  async function startRenaming() {
    await openDashboardMenu();
    await act(async () =>
      document.querySelector<HTMLElement>("[role=menuitem]")!.click(),
    );
  }

  it.each(["menu", "rename dialog"])(
    "closes the %s when the connection veil appears",
    async (surface) => {
      await choose("Night");
      if (surface === "menu") await openDashboardMenu();
      else await startRenaming();
      expect(
        document.querySelector("[role=menu], [role=dialog]"),
      ).not.toBeNull();

      await act(async () => coreStatus.publish({ state: "offline" }));

      expect(container.querySelector(".veil")?.textContent).toContain(
        "Reconnecting",
      );
      expect(document.querySelector("[role=menu], [role=dialog]")).toBeNull();
      await act(async () =>
        coreStatus.publish({ state: "online", version: "dev" }),
      );
      expect(document.querySelector("[role=menu], [role=dialog]")).toBeNull();
      expect(
        container.querySelector('button[aria-label="Night: more"]'),
      ).not.toBeNull();
    },
  );

  it("closes a rename when another client removes that dashboard", async () => {
    await choose("Night");
    await startRenaming();

    await act(async () =>
      socket.push({ type: "dashboards", dashboards: [homeDashboard] }),
    );

    expect(title()).toBe("Home");
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(coreJson).not.toHaveBeenCalledWith(
      "/api/dashboards/update",
      expect.anything(),
    );
  });

  it("lists them in the sidebar in their order, the one on show White, Home with its house", async () => {
    const items = await dashboardItems();
    expect(items.map((item) => item.textContent)).toEqual(["Home", "Night"]);
    expect(items.map((item) => item.getAttribute("aria-current"))).toEqual([
      "page",
      null,
    ]);
    expect(items[0]!.querySelector("svg.lucide-house")).not.toBeNull();
    expect(
      items[1]!.querySelector<HTMLElement>("span[aria-hidden]")?.style
        .background,
    ).toBe("var(--dashboard-mocha)");
    expect(title()).toBe("Home");
  });

  it("draws the page on the current dashboard's background, in a frame of it deepened", () => {
    expect(
      container.querySelector<HTMLElement>(".panel")!.style.background,
    ).toBe("var(--dashboard-mocha)");
    expect(
      container.querySelector<HTMLElement>(".frame-place")!.style.background,
    ).toBe("var(--dashboard-mocha-deep)");
  });

  it("shows the one chosen in the sidebar, and still after a restart", async () => {
    await openKitchen();
    await choose("Night");
    expect(title()).toBe("Night");
    expect(pageTitle()).toBe("Night");

    await act(async () => root.unmount());
    root = createRoot(container);
    await act(async () => renderHome());
    expect(title()).toBe("Night");
    expect(
      (await dashboardItems()).map((item) => item.getAttribute("aria-current")),
    ).toEqual([null, "page"]);
  });

  it("marks none in the sidebar while another page is on show", async () => {
    await openKitchen();
    expect(
      (await dashboardItems()).map((item) => item.getAttribute("aria-current")),
    ).toEqual([null, null]);
  });

  it("follows what the core pushes", async () => {
    await act(async () =>
      socket.push({
        type: "dashboards",
        dashboards: [{ ...night, name: "Bedtime" }, homeDashboard],
      }),
    );
    expect(title()).toBe("Home");
    expect((await dashboardItems()).map((item) => item.textContent)).toEqual([
      "Bedtime",
      "Home",
    ]);
  });

  it("falls back to the first when the one on show is gone", async () => {
    await choose("Night");
    await act(async () =>
      socket.push({ type: "dashboards", dashboards: [homeDashboard] }),
    );
    expect(title()).toBe("Home");
  });

  it("renames the one on show from its menu, on a shared client too", async () => {
    await choose("Night");
    await startRenaming();
    const input = document.querySelector<HTMLInputElement>(
      "[role=dialog] input",
    )!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, "Bedtime");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () =>
      [...document.querySelectorAll<HTMLButtonElement>("[role=dialog] button")]
        .find((button) => button.textContent === "Save")!
        .click(),
    );

    expect(coreJson).toHaveBeenCalledWith("/api/dashboards/update", {
      method: "POST",
      json: { id: "d-night", name: "Bedtime" },
    });
    expect(title()).toBe("Bedtime");
    await vi.waitFor(() =>
      expect(document.querySelector("[role=dialog]")).toBeNull(),
    );
  });

  it("opens Home editing from the empty card on another dashboard", async () => {
    await act(async () =>
      socket.push({
        type: "device",
        id: "unknown",
        device: {
          id: "unknown",
          name: "Unknown device",
          driverName: "Unknown device",
          type: "unknown",
          driver: "sanctum.zigbee",
          manufacturer: null,
          model: null,
          roomId: null,
          availability: "online",
          lastSeenAt: null,
          firmware: null,
          probe: false,
          battery: null,
          leftAt: null,
          capabilities: [],
        },
      }),
    );
    await choose("Night");
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("main button")]
        .find((button) => button.textContent === "Edit Home")!
        .click();
    });
    expect(pageTitle()).toBe("Edit Home");
    expect(title()).toBe("Edit HomeDone");
    expect(container.textContent).toContain("Unknown device");
  });

  it("has no menu off the dashboards", async () => {
    await openKitchen();
    expect(
      container.querySelector("header button[aria-label$=more]"),
    ).toBeNull();
  });
});

describe("the pinned apps", () => {
  const tiles = () =>
    [
      ...container.querySelectorAll<HTMLButtonElement>(
        'aside ul[aria-label="Pinned apps"] button',
      ),
    ].map((tile) => tile.getAttribute("aria-label"));
  const tile = (name: string) =>
    container.querySelector<HTMLButtonElement>(
      `aside ul[aria-label="Pinned apps"] button[aria-label="${name}"]`,
    )!;
  const press = async (button: HTMLButtonElement) => {
    await act(async () => {
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  };

  it("are the household's, Apps last, each opening its app and marked while it is on show", async () => {
    pins = ["sanctum.settings", "sanctum.gone"];
    await refresh();
    // An app this client cannot open has no tile.
    expect(tiles()).toEqual(["Settings", "Apps"]);
    await press(tile("Settings"));
    expect(pageTitle()).toBe("Settings");
    expect(tile("Settings").getAttribute("aria-current")).toBe("page");
    expect(tile("Apps").getAttribute("aria-current")).toBeNull();
  });

  it("mark Apps while the page of an app that isn't pinned is on show", async () => {
    await openFromOverview("Automations");
    expect(pageTitle()).toBe("Automations");
    expect(tile("Apps").getAttribute("aria-current")).toBe("page");
  });

  it("are pinned from Apps for every device, and follow what the core pushes", async () => {
    expect(tiles()).toEqual(["Pin apps", "Apps"]);
    await press(tile("Pin apps"));
    expect(pageTitle()).toBe("Apps");
    await press(
      [
        ...container.querySelectorAll<HTMLButtonElement>(".top-bar button"),
      ].find((button) => button.textContent === "Pin apps")!,
    );
    await press(
      container.querySelector<HTMLButtonElement>(
        'main button[aria-label="Pin Automations"]',
      )!,
    );
    expect(coreJson).toHaveBeenCalledWith("/api/pins/update", {
      method: "POST",
      json: { apps: ["sanctum.automations"] },
    });
    expect(tiles()).toEqual(["Automations", "Apps"]);

    await act(async () => socket.push({ type: "pins", apps: [] }));
    expect(tiles()).toEqual(["Pin apps", "Apps"]);
  });
});

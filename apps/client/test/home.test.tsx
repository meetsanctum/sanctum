// @vitest-environment jsdom
import type { AppInfo, EntityInfo, WidgetContent } from "@meetsanctum/app-sdk";
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  homeDashboard,
  moods,
  naturalLight,
  night,
  weather,
} from "./home-shell-fixtures";
import {
  container,
  homeData,
  mockCoreJson,
  publishCoreStatus,
  pushLive,
  refresh,
  remountHome,
} from "./home-shell-harness";
import { light } from "./settings-devices-fixtures";

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

// One of Settings' areas, from its row on Settings' first page.
async function openArea(name: string) {
  await act(async () => {
    [
      ...container.querySelectorAll<HTMLButtonElement>(
        'main nav[aria-label="Settings"] button',
      ),
    ]
      .find((button) => button.textContent?.startsWith(name))!
      .click();
  });
}

// The way back before a page's title, by the page it returns to.
const backTo = (name: string) =>
  container.querySelector<HTMLButtonElement>(
    `.top-bar button[aria-label="Back to ${name}"]`,
  );

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

  it("lists Sanctum's own apps and every installed one in the overview, by name, opening each in its place", async () => {
    expect(await openFromOverview("Settings")).toEqual([
      "Automations",
      "Moods",
      "Settings",
    ]);
    expect(pageTitle()).toBe("Settings");
    expect(container.querySelector("main")?.textContent).toContain("Apps1 app");
    expect(backShown()).toBe(false);

    await openArea("Apps");
    expect(pageTitle()).toBe("Apps");
    expect(container.querySelector("main")?.textContent).toContain(
      "MoodsVersion 0.1.0",
    );
    await act(async () => backTo("Settings")!.click());
    expect(pageTitle()).toBe("Settings");
  });
});

describe("Settings' pages", () => {
  const goHome = async () =>
    act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("aside button")]
        .find((button) => button.textContent?.startsWith("Home"))!
        .click();
    });

  it("open a step of the setup guide on its page, over Settings' first", async () => {
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("main button")]
        .find((button) => button.textContent === "Add devices")!
        .click();
    });

    expect(pageTitle()).toBe("Devices");
    expect(container.querySelector('[role="dialog"]')?.textContent).toContain(
      "Add devices",
    );
  });

  it("name the page under them on Back, as Status does over System", async () => {
    await openFromOverview("Settings");
    await openArea("System");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('main button[aria-label^="Status:"]')!
        .click();
    });

    expect(pageTitle()).toBe("Status");
    await act(async () => backTo("System")!.click());
    expect(pageTitle()).toBe("System");
    await act(async () => backTo("Settings")!.click());
    expect(pageTitle()).toBe("Settings");
  });

  it("open again where Settings was left, until it is left on its first page", async () => {
    await openFromOverview("Settings");
    await openArea("Devices");
    await goHome();
    await openFromOverview("Settings");
    expect(pageTitle()).toBe("Devices");

    await act(async () => backTo("Settings")!.click());
    await goHome();
    await openFromOverview("Settings");
    expect(pageTitle()).toBe("Settings");
  });

  it("opens Needs attention from Home even when Settings was left on another page", async () => {
    const lamp = light("lamp", "Lamp", {
      availability: "offline",
      roomId: "kitchen",
    });
    homeData.devices = [lamp];
    await refresh();
    await openFromOverview("Settings");
    await openArea("Devices");
    await goHome();

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          'main button[aria-label="Lamp is offline"]',
        )!
        .click(),
    );

    expect(pageTitle()).toBe("Settings");
    expect(container.querySelector("#settings-attention")).not.toBeNull();
  });

  it("reopens the remembered area from a Settings page opened outside Settings", async () => {
    homeData.pins = ["sanctum.settings"];
    await refresh();
    await openFromOverview("Settings");
    await openArea("Devices");
    await openFromOverview("Moods");
    expect(pageTitle()).toBe("Moods settings");

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          'aside ul[aria-label="Pinned apps"] button[aria-label="Settings"]',
        )!
        .click(),
    );

    expect(pageTitle()).toBe("Devices");
    expect(backTo("Settings")).not.toBeNull();
  });

  it("starts each Settings page at the top of its scroll area", async () => {
    await openFromOverview("Settings");
    const main = container.querySelector("main")!;
    main.scrollTop = 250;

    await openArea("Devices");

    expect(container.querySelector("main")!.scrollTop).toBe(0);
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

  it("open from Settings → Apps, and Back before their title returns to Apps", async () => {
    await openFromOverview("Settings");
    await openArea("Apps");
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("main li button")]
        .find((button) => button.textContent?.startsWith("Moods"))!
        .click();
    });

    expect(pageTitle()).toBe("Moods settings");
    expect(backShown()).toBe(false);
    await act(async () => backTo("Apps")!.click());
    expect(pageTitle()).toBe("Apps");
  });

  it("are the page Apps opens for an app without one of its own, over Apps, so Done returns there", async () => {
    await openFromOverview("Moods");
    expect(pageTitle()).toBe("Moods settings");
    expect(backShown()).toBe(false);
    await done();
    expect(pageTitle()).toBe("Apps");
  });

  it("open from the same button at the end of the bar on every app page, never on Sanctum's own", async () => {
    homeData.installed = [moods, weather];
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
    homeData.installed = [moods, naturalLight];
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
    homeData.installed = [moods, weather];
    await refresh();
    await openFromOverview("Settings");
    await openArea("Apps");
    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("main li button")]
        .find((button) => button.textContent?.startsWith("Weather"))!
        .click();
    });
    homeData.installed = [moods];
    await refresh();

    expect(pageTitle()).toBe("Apps");
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
    homeData.installed = [];
    await refresh();
    expect(pageTitle()).toBe("Kitchen");
  });

  it.each([
    { name: "app", apps: [moods] },
    { name: "page", apps: [moods, { ...weather, pages: [] }] },
  ])("returns home when the current $name disappears", async ({ apps }) => {
    homeData.installed = [moods, weather];
    await refresh();
    await openFromOverview("Weather");
    expect(pageTitle()).toBe("Weather");
    homeData.installed = apps;
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
    mockCoreJson
      .mockResolvedValueOnce({ client: { kind: "shared" }, person: null })
      .mockReturnValueOnce(pending);
    await refresh();
    homeData.installed = [];
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
    homeData.devices = [light("lamp", "Lamp")];
  });

  it("draws each card on Home after the rooms, from what its app shows, and follows it", async () => {
    homeData.installed = [moods, withCard];
    homeData.entities = [
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
      pushLive({
        type: "entity",
        app: "sanctum.weather",
        key: "home",
        entity: card({ blocks: [{ kind: "note", text: "Rain soon." }] }),
        was: "weather.card",
      }),
    );
    expect(cardOnHome()?.textContent).toBe("WeatherRain soon.");

    await act(async () =>
      pushLive({
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
    homeData.installed = [withCard];
    homeData.entities = [
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

    expect(mockCoreJson).toHaveBeenCalledWith(
      "/api/apps/sanctum.weather/actions/weather.remind",
      { method: "POST", json: { thing: "umbrella" } },
    );
  });

  it("shows none for an app that has shown no card", async () => {
    homeData.installed = [moods, withCard];
    await refresh();

    expect(cardOnHome()).toBeNull();
  });
});

describe("the home's dashboards", () => {
  beforeEach(async () => {
    homeData.dashboards = [homeDashboard, night];
    await refresh();
  });

  const dashboardItems = async () =>
    (await showSidebar()).slice(0, homeData.dashboards.length);

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

      await act(async () => publishCoreStatus({ state: "offline" }));

      expect(container.querySelector(".veil")?.textContent).toContain(
        "Reconnecting",
      );
      expect(document.querySelector("[role=menu], [role=dialog]")).toBeNull();
      await act(async () =>
        publishCoreStatus({ state: "online", version: "dev" }),
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
      pushLive({ type: "dashboards", dashboards: [homeDashboard] }),
    );

    expect(title()).toBe("Home");
    expect(document.querySelector("[role=dialog]")).toBeNull();
    expect(mockCoreJson).not.toHaveBeenCalledWith(
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

    await remountHome();
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
      pushLive({
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
      pushLive({ type: "dashboards", dashboards: [homeDashboard] }),
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

    expect(mockCoreJson).toHaveBeenCalledWith("/api/dashboards/update", {
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
      pushLive({
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
          identify: false,
          battery: null,
          batteryLow: null,
          shownAs: null,
          leftAt: null,
          problem: null,
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
    homeData.pins = ["sanctum.settings", "sanctum.gone"];
    await refresh();
    // An app the home doesn't have has no tile.
    expect(tiles()).toEqual(["Settings", "Apps"]);
    await press(tile("Settings"));
    expect(pageTitle()).toBe("Settings");
    expect(tile("Settings").getAttribute("aria-current")).toBe("page");
    expect(tile("Apps").getAttribute("aria-current")).toBeNull();
  });

  it("mark an app without a page of its own while its settings are on show", async () => {
    homeData.pins = ["sanctum.settings", "sanctum.moods"];
    await refresh();
    await press(tile("Moods"));
    expect(pageTitle()).toBe("Moods settings");
    expect(tile("Moods").getAttribute("aria-current")).toBe("page");
    expect(tile("Settings").getAttribute("aria-current")).toBeNull();
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
    expect(mockCoreJson).toHaveBeenCalledWith("/api/pins/update", {
      method: "POST",
      json: { apps: ["sanctum.automations"] },
    });
    expect(tiles()).toEqual(["Automations", "Apps"]);

    await act(async () => pushLive({ type: "pins", apps: [] }));
    expect(tiles()).toEqual(["Pin apps", "Apps"]);
  });
});

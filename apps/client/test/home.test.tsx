// @vitest-environment jsdom
import type { AppInfo, EntityInfo, WidgetContent } from "@meetsanctum/app-sdk";
import { act } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  homeDashboard,
  moods,
  naturalLight,
  night,
  weather,
} from "./home-shell-fixtures";
import {
  backShown,
  container,
  homeData,
  mockCoreJson,
  openFromOverview,
  pageTitle,
  placesSnapshot,
  publishCoreStatus,
  pushLive,
  refresh,
  remountHome,
} from "./home-shell-harness";
import { light } from "./settings-devices-fixtures";

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

// Settings and Automations load when first opened (Home.tsx): loaded here
// first, they open as quickly as the tests look for them.
beforeAll(() =>
  Promise.all([import("../src/settings"), import("../src/automations/page")]),
);

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
    const fade = container.querySelector(".top-fade")!;
    expect(fade.matches(".panel[data-flat] .top-fade")).toBe(false);
    const tile = container.querySelector<HTMLButtonElement>(
      'aside button[aria-label="Apps"]',
    )!;
    await act(async () => tile.click());
    expect(pageTitle()).toBe("Apps");
    expect(container.querySelector("main")!.className).toBe("page app-page");
    expect(fade.matches(".panel[data-flat] .top-fade")).toBe(true);
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

  it("keeps an open page when the app list has not changed", async () => {
    await openKitchen();
    await refresh();
    expect(pageTitle()).toBe("Kitchen");
  });

  it("starts the next room's page at the top, not where the last was left", async () => {
    homeData.rooms = [
      ...homeData.rooms,
      { id: "bedroom", name: "Bedroom", floorId: null },
    ];
    await refresh();
    await openKitchen();
    container.querySelector("main")!.scrollTop = 250;

    await choose("Bedroom");

    expect(pageTitle()).toBe("Bedroom");
    expect(container.querySelector("main")!.scrollTop).toBe(0);
  });

  it("keeps a room's page when Moods goes: rooms are the shell's", async () => {
    await openKitchen();
    homeData.installed = [];
    await refresh();
    expect(pageTitle()).toBe("Kitchen");
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
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '.top-bar button[aria-label="Moods settings"]',
        )!
        .click(),
    );
    expect(pageTitle()).toBe("Moods Settings");

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

    expect(pageTitle()).toBe("Moods Settings");
    expect(backShown()).toBe(false);
    await act(async () => backTo("Apps")!.click());
    expect(pageTitle()).toBe("Apps");
  });

  it("open over the default page Apps shows for an app without one of its own, and Done returns there", async () => {
    await openFromOverview("Moods");
    // The shell's own page: the app's name and version, no settings yet.
    expect(pageTitle()).toBe("Moods");
    expect(container.querySelector("main")?.textContent).toContain(
      `Version ${moods.version}`,
    );
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '.top-bar button[aria-label="Moods settings"]',
        )!
        .click(),
    );
    expect(pageTitle()).toBe("Moods Settings");
    await done();
    expect(pageTitle()).toBe("Moods");
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
    expect(pageTitle()).toBe("Weather Settings");
    expect(gear("Weather")).toBeNull();

    await openFromOverview("Settings");
    expect(
      container.querySelector(".top-bar [aria-label$=' settings']"),
    ).toBeNull();
  });

  it("open from the app's own page, and Done returns to it", async () => {
    homeData.installed = [moods, naturalLight];
    await refresh();
    await openFromOverview("Natural Light");
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Natural Light settings"]',
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
      container.querySelector('button[aria-label="Natural Light settings"]'),
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
          {
            kind: "line",
            text: "Updated {time}",
            values: { time: { time: "2026-11-03T18:30:00Z" } },
          },
          { kind: "note", text: "No forecast yet." },
        ],
      }),
    ];
    await refresh();

    const shown = cardOnHome()!;
    expect(shown.textContent).toBe("Weather8°Updated 18:30No forecast yet.");
    expect(shown.querySelector("h2")?.style.color).toBe("var(--sky-text)");
    // Last on Home, after the rooms.
    expect(shown.parentElement).toBe(
      container.querySelector("main")?.lastElementChild,
    );

    const places = placesSnapshot();
    await act(async () =>
      pushLive({
        type: "places",
        places: {
          ...places,
          home: { ...places.home, temperatureUnit: "fahrenheit" },
        },
      }),
    );
    expect(cardOnHome()?.textContent).toBe(
      "Weather47°Updated 18:30No forecast yet.",
    );

    await act(async () =>
      pushLive({
        type: "places",
        places: {
          ...places,
          home: {
            ...places.home,
            temperatureUnit: "fahrenheit",
            hourCycle: "12h",
          },
        },
      }),
    );
    expect(cardOnHome()?.textContent).toBe(
      "Weather47°Updated 6:30 PMNo forecast yet.",
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

  async function openDashboardMenu(name = "Night") {
    await act(async () =>
      container
        .querySelector(`button[aria-label="${name}: more"]`)!
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

  it("starts the next dashboard at the top, not where the last was left", async () => {
    container.querySelector("main")!.scrollTop = 250;

    await choose("Night");

    expect(title()).toBe("Night");
    expect(container.querySelector("main")!.scrollTop).toBe(0);
  });

  it("starts Home at the top when returning from a room", async () => {
    await openKitchen();
    container.querySelector("main")!.scrollTop = 250;

    await choose("Home");

    expect(pageTitle()).toBe("Home");
    expect(container.querySelector("main")!.scrollTop).toBe(0);
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

  it("keeps a room's scroll position when the selected dashboard is removed", async () => {
    await choose("Night");
    expect(pageTitle()).toBe("Night");
    await openKitchen();
    container.querySelector("main")!.scrollTop = 250;

    await act(async () =>
      pushLive({ type: "dashboards", dashboards: [homeDashboard] }),
    );

    expect((await showSidebar()).map((item) => item.textContent)).not.toContain(
      "Night",
    );
    expect(pageTitle()).toBe("Kitchen");
    expect(container.querySelector("main")!.scrollTop).toBe(250);
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

  it("starts at the top when entering and leaving Edit Home", async () => {
    homeData.devices = [light("lamp", "Lamp", { roomId: "kitchen" })];
    await refresh();
    await openDashboardMenu("Home");
    container.querySelector("main")!.scrollTop = 250;

    await act(async () =>
      document.querySelector<HTMLElement>("[role=menuitem]")!.click(),
    );

    expect(pageTitle()).toBe("Edit Home");
    expect(container.querySelector("main")!.scrollTop).toBe(0);
    container.querySelector("main")!.scrollTop = 250;

    await act(async () => {
      [...container.querySelectorAll<HTMLButtonElement>("header button")]
        .find((button) => button.textContent === "Done")!
        .click();
    });

    expect(pageTitle()).toBe("Home");
    expect(container.querySelector("main")!.scrollTop).toBe(0);
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

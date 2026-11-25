// @vitest-environment jsdom
import type { AppInfo } from "@meetsanctum/app-sdk";
import { act } from "react";
import { beforeAll, describe, expect, it } from "vitest";

import zigbeeManifest from "../../../catalog/apps/zigbee/sanctum-app.json";
import { moods, weather } from "./home-shell-fixtures";
import {
  backShown,
  container,
  homeData,
  mockCoreJson,
  openFromOverview,
  pageTitle,
  pushLive,
  refresh,
} from "./home-shell-harness";
import { light, zigbee } from "./settings-devices-fixtures";

beforeAll(() =>
  Promise.all([import("../src/settings"), import("../src/automations/page")]),
);

describe("the home's installed apps", () => {
  it("returns home when the current app disappears", async () => {
    homeData.installed = [moods, weather];
    await refresh();
    await openFromOverview("Weather");
    expect(pageTitle()).toBe("Weather");
    homeData.installed = [moods];
    await refresh();
    expect(pageTitle()).toBe("Home");
    expect(container.querySelector("header")?.textContent).toBe("Home");
    expect(backShown()).toBe(false);
  });

  it("shows the default page when the app's own main page disappears", async () => {
    homeData.installed = [moods, weather];
    await refresh();
    await openFromOverview("Weather");
    homeData.installed = [moods, { ...weather, pages: [] }];
    await refresh();
    expect(pageTitle()).toBe("Weather");
    expect(container.querySelector("main")?.textContent).toContain(
      `Version ${weather.version}`,
    );
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

describe("the default app page", () => {
  const driver: AppInfo = {
    ...zigbee,
    pages: zigbeeManifest.pages,
    backdrop: zigbeeManifest.backdrop,
  };
  const summary = "Connects devices to your home.";
  const showDevices = () =>
    [...container.querySelectorAll<HTMLButtonElement>("main button")].find(
      (button) => button.textContent === "Show devices",
    );

  it("paints Zigbee's red backdrop on the shell panel", async () => {
    homeData.installed = [driver];
    await refresh();
    await openFromOverview("Zigbee");

    expect(pageTitle()).toBe("Zigbee");
    expect(
      container.querySelector<HTMLElement>(".panel")!.style.background,
    ).toContain(
      "linear-gradient(to top right, rgb(154, 2, 48), rgb(235, 4, 67))",
    );
  });

  it("opens the device list and goes back to the app that opened it", async () => {
    homeData.installed = [driver];
    homeData.manifests.set(driver.id, { summary, driver: { hooks: [] } });
    homeData.devices = [light("hall-light", "Hall Light")];
    await refresh();
    await openFromOverview("Zigbee");

    await act(async () => showDevices()!.click());
    expect(pageTitle()).toBe("Devices");
    expect(container.querySelector("main")?.textContent).toContain(
      "Hall Light",
    );

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '.top-bar button[aria-label="Back to Zigbee"]',
        )!
        .click(),
    );
    expect(pageTitle()).toBe("Zigbee");
    expect(showDevices()).toBeDefined();
  });

  it("clears the previous app's details while the next manifest loads", async () => {
    homeData.installed = [driver, moods];
    homeData.pins = [driver.id, moods.id];
    homeData.manifests.set(driver.id, { summary, driver: { hooks: [] } });
    let resolve!: (manifest: { summary: string }) => void;
    const pending = new Promise<{ summary: string }>((done) => {
      resolve = done;
    });
    homeData.manifests.set(moods.id, pending);
    await refresh();
    await openFromOverview("Zigbee");
    expect(container.querySelector("main")?.textContent).toContain(summary);
    expect(showDevices()).toBeDefined();

    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('aside button[aria-label="Moods"]')!
        .click(),
    );
    expect(pageTitle()).toBe("Moods");
    expect(container.querySelector("main")?.textContent).not.toContain(summary);
    expect(showDevices()).toBeUndefined();

    await act(async () => resolve({ summary: "Sets the mood in your rooms." }));
    expect(container.querySelector("main")?.textContent).toContain(
      "Sets the mood in your rooms.",
    );
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

  it("mark an app without a page of its own while its default page is on show", async () => {
    homeData.pins = ["sanctum.settings", "sanctum.moods"];
    await refresh();
    await press(tile("Moods"));
    expect(pageTitle()).toBe("Moods");
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

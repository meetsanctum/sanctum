// @vitest-environment jsdom
import type { AvailableApp, HardwareOffer } from "@meetsanctum/app-sdk";
import { act } from "react";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";

import {
  backTo,
  container,
  homeData,
  mockCoreJson,
  openArea,
  openFromOverview,
  pageTitle,
  pushLive,
  refresh,
} from "./home-shell-harness";
import { light, maya } from "./settings-devices-fixtures";
import { piStatus } from "./system-status-fixtures";

beforeAll(() => import("../src/settings"));

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

  it("keep how Sanctum is doing and its updates on one System page, with Back to Settings", async () => {
    await openFromOverview("Settings");
    await openArea("System");

    expect(pageTitle()).toBe("System");
    expect(
      container.querySelector('section[aria-labelledby="status-sanctum"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('section[aria-labelledby="status-updates"]'),
    ).not.toBeNull();
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

  it("open again on a category's page of Devices, with Back to Devices", async () => {
    homeData.devices = [light("lamp", "Lamp")];
    await refresh();
    await openFromOverview("Settings");
    await openArea("Devices");
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          'main button[aria-label="Lights: 1 device"]',
        )!
        .click(),
    );
    expect(pageTitle()).toBe("Lights");
    await goHome();

    await openFromOverview("Settings");
    expect(pageTitle()).toBe("Lights");
    await act(async () => backTo("Devices")!.click());
    expect(pageTitle()).toBe("Devices");
  });

  it("focuses Add devices when the last category disappears and keeps focus there on a live addition", async () => {
    const lamp = light("lamp", "Lamp");
    homeData.devices = [lamp];
    await refresh();
    await openFromOverview("Settings");
    await openArea("Devices");
    const lights = () =>
      container.querySelector<HTMLButtonElement>(
        'main button[aria-label="Lights: 1 device"]',
      );
    await act(async () => lights()!.click());

    homeData.devices = [];
    await act(async () =>
      pushLive({ type: "device", id: lamp.id, device: null }),
    );
    await act(async () => backTo("Devices")!.click());
    expect(container.textContent).toContain("No devices yet.");
    const add = [...container.querySelectorAll(".top-bar button")].find(
      (button) => button.textContent === "Add devices",
    );
    expect(document.activeElement).toBe(add);

    await act(async () =>
      pushLive({ type: "device", id: lamp.id, device: lamp }),
    );
    expect(lights()).not.toBeNull();
    expect(document.activeElement).toBe(add);
  });

  it("reopens a new person's page without asking about sign-in again", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
      },
    );
    let people: (typeof maya)[] = [];
    const usual = mockCoreJson.getMockImplementation()!;
    mockCoreJson.mockImplementation(async (path, init) => {
      switch (path) {
        case "/api/people":
          return people;
        case "/api/people/add":
          people = [maya];
          return maya;
        case "/api/auth/logins":
        case "/api/auth/invites":
        case "/api/auth/invites?includeRecovery=true":
        case "/api/auth/clients":
        case "/api/auth/agents":
          return [];
        default:
          return usual(path, init);
      }
    });
    const dialog = () => document.querySelector('[role="dialog"]');
    const button = (scope: ParentNode, label: string) =>
      [...scope.querySelectorAll("button")].find(
        (each) => each.textContent === label,
      )!;

    await openFromOverview("Settings");
    await openArea("People");
    await act(async () => button(container, "Add a person").click());
    const name = dialog()!.querySelector("input")!;
    const value = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    )!;
    await act(async () => {
      value.set!.call(name, maya.name);
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => button(dialog()!, "Add").click());
    expect(dialog()?.textContent).toContain("Will Maya sign in?");
    await act(async () => button(dialog()!, "Not now").click());
    await goHome();

    await openFromOverview("Settings");
    expect(pageTitle()).toBe(maya.name);
    expect(dialog()).toBeNull();
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

describe("repairing a blocked app add", () => {
  function offerApp(shortfall: AvailableApp["shortfalls"][number]) {
    const app: AvailableApp = {
      id: "sanctum.example",
      name: "Example",
      version: "1.0.0",
      icon: null,
      summary: null,
      requests: [],
      memory: 128,
      data: 256,
      adds: { devices: false },
      shortfalls: [shortfall],
    };
    const answer = mockCoreJson.getMockImplementation()!;
    mockCoreJson.mockImplementation(async (path, init) => {
      if (path === "/api/apps/available") return [app];
      if (path === "/api/system/status") return piStatus();
      return answer(path, init);
    });
    return app;
  }

  const dialog = () => document.querySelector('[role="dialog"]');
  const storage = () =>
    container.querySelector('section[aria-labelledby="status-storage"]');
  const spaceShortfall = {
    kind: "space",
    needs: 256_000_000,
    free: 0,
  } as const;

  const pressRepair = async (name: string) =>
    act(async () =>
      [...dialog()!.querySelectorAll("button")]
        .find((button) => button.textContent === name)!
        .click(),
    );

  async function openAddSheet() {
    await openFromOverview("Settings");
    await openArea("Apps");
    const main = container.querySelector("main")!;
    main.scrollTop = 250;
    await act(async () =>
      main
        .querySelector<HTMLButtonElement>('button[aria-label="Add Example"]')!
        .click(),
    );
    return main;
  }

  function captureScrolls() {
    const targets: Element[] = [];
    const original = Object.getOwnPropertyDescriptor(
      Element.prototype,
      "scrollIntoView",
    );
    Element.prototype.scrollIntoView = function () {
      targets.push(this);
    };
    onTestFinished(() => {
      if (original)
        Object.defineProperty(Element.prototype, "scrollIntoView", original);
      else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    });
    return targets;
  }

  it("opens System at Storage and goes back to Apps", async () => {
    offerApp(spaceShortfall);
    const targets = captureScrolls();
    await openAddSheet();
    await pressRepair("Free up space");

    expect(dialog()).toBeNull();
    expect(pageTitle()).toBe("System");
    expect(storage()).not.toBeNull();
    expect(targets).toEqual([storage()]);
    await act(async () => backTo("Apps")!.click());
    expect(pageTitle()).toBe("Apps");
  });

  it("returns to the installed apps and keeps one Back entry", async () => {
    offerApp({ kind: "memory", needs: 128 * 1024 ** 2, free: 60 * 1024 ** 2 });
    const main = await openAddSheet();
    expect(main.scrollTop).toBe(250);
    await pressRepair("Show apps");

    expect(dialog()).toBeNull();
    expect(pageTitle()).toBe("Apps");
    expect(main.scrollTop).toBe(0);
    await act(async () => backTo("Settings")!.click());
    expect(pageTitle()).toBe("Settings");
  });

  it("opens Storage on the existing System page and preserves the hardware offer", async () => {
    const app = offerApp(spaceShortfall);
    const targets = captureScrolls();
    await openFromOverview("Settings");
    await openArea("System");
    const offer: HardwareOffer = {
      id: "offer-1",
      app: app.id,
      sticks: [{ path: "/dev/ttyACM0", label: "Zigbee stick" }],
    };
    await act(async () => pushLive({ type: "offer", offer }));
    await pressRepair("Free up space");

    expect(dialog()).toBeNull();
    expect(storage()).not.toBeNull();
    expect(targets).toEqual([storage()]);
    expect(
      mockCoreJson.mock.calls.some(
        ([path]) => path === "/api/hardware/offer/dismiss",
      ),
    ).toBe(false);
    await act(async () => pushLive({ type: "offer", offer: { ...offer } }));
    expect(dialog()).toBeNull();
    await act(async () => backTo("Settings")!.click());
    expect(pageTitle()).toBe("Settings");
  });
});

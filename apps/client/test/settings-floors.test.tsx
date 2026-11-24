// @vitest-environment jsdom
import type { AppInfo, FloorRemoval, Places } from "@meetsanctum/app-sdk";
import type { Me } from "@meetsanctum/auth-protocol";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { SettingsPage } from "../src/settings";
import {
  floorDetail,
  floorRemovalWarning,
  inOrder,
} from "../src/settings-floors";
import { unknownHome } from "./home-fixtures";

// Settings → Rooms' floors: their lines and order, the sheet that adds and
// edits one with the rooms on it, a room's Floor menu, and what removing
// one says first.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const ground = { id: "ground", name: "Ground floor", level: 0 };
const first = { id: "first", name: "First floor", level: 1 };
const kitchen = { id: "kitchen", name: "Kitchen", floorId: "ground" };
const hall = { id: "hall", name: "Hall", floorId: "ground" };
const bedroom = { id: "bedroom", name: "Bedroom", floorId: "first" };
const office = { id: "office", name: "Office", floorId: null };
const home = {
  name: "Home",
  timeZone: "UTC",
  temperatureUnit: "celsius",
  hourCycle: "24h",
} as const;

describe("a floor's line and order", () => {
  const places: Places = {
    home,
    floors: [ground, first],
    rooms: [bedroom, hall, kitchen, office],
    zones: [],
  };

  it("names the rooms on it, or says it has none", () => {
    expect(floorDetail(ground, places)).toBe("Hall and Kitchen");
    expect(floorDetail(first, places)).toBe("Bedroom");
    expect(floorDetail({ ...first, id: "attic" }, places)).toBe("No rooms yet");
  });

  it("numbers the floors from 0 in a new order", () => {
    expect(inOrder(places, ["first", "ground"]).floors).toEqual([
      { ...first, level: 0 },
      { ...ground, level: 1 },
    ]);
  });

  it("keeps floors added while an optimistic order was on its way", () => {
    const outside = { id: "outside", name: "Outside", level: 2 };
    expect(
      inOrder({ ...places, floors: [...places.floors, outside] }, [
        "first",
        "ground",
      ]).floors,
    ).toEqual([{ ...first, level: 0 }, { ...ground, level: 1 }, outside]);
  });

  it("says first that its rooms stay and which workflows use it", () => {
    expect(
      floorRemovalWarning({
        rooms: [
          { id: "hall", name: "Hall" },
          { id: "kitchen", name: "Kitchen" },
        ],
        workflows: [{ id: "w", name: "Downstairs off" }],
      }),
    ).toEqual([
      "Hall and Kitchen stay, on no floor.",
      "The workflow “Downstairs off” uses it and will need changing.",
    ]);
    expect(
      floorRemovalWarning({
        rooms: [{ id: "hall", name: "Hall" }],
        workflows: [],
      }),
    ).toEqual(["Hall stays, on no floor."]);
    expect(floorRemovalWarning({ rooms: [], workflows: [] })).toEqual([]);
  });
});

describe("Settings → Rooms' floors", () => {
  let root: Root;
  let container: HTMLDivElement;
  let places: Places;
  let removal: FloorRemoval;
  let requests: { path: string; json?: unknown }[];
  const live = createLiveFeed();
  const me = {
    client: {
      id: "tablet",
      name: "Hall tablet",
      kind: "shared",
      platform: "android",
      personId: null,
      createdAt: "2026-10-26T12:00:00Z",
      lastSeenAt: "2026-10-28T11:59:30Z",
      connectedSince: null,
      current: true,
    },
    person: null,
  } as unknown as Me;
  const apps: AppInfo[] = [];

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // Radix measures checkboxes and submenus, which jsdom can't.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    places = {
      home,
      floors: [ground, first],
      rooms: [bedroom, hall, kitchen, office],
      zones: [],
    };
    removal = { rooms: [], workflows: [] };
    requests = [];
    vi.mocked(coreJson).mockReset();
    vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
      requests.push({ path, json: init.json });
      if (path.startsWith("/api/places/floors/removal?")) return removal;
      if (path.startsWith("/api/activity?"))
        return { entries: [], more: false };
      switch (path) {
        case "/api/places":
          return places;
        case "/api/devices":
          return [];
        // The core keeps what changed, which the page reads again.
        case "/api/places/floors/add": {
          const { name } = init.json as { name: string };
          const floor = { id: "new-floor", name, level: places.floors.length };
          places = { ...places, floors: [...places.floors, floor] };
          return floor;
        }
        case "/api/places/floors/update": {
          const { id, name } = init.json as { id: string; name: string };
          places = {
            ...places,
            floors: places.floors.map((floor) =>
              floor.id === id ? { ...floor, name } : floor,
            ),
          };
          return places.floors.find((floor) => floor.id === id);
        }
        case "/api/places/rooms/update": {
          const { id, floorId } = init.json as {
            id: string;
            floorId: string | null;
          };
          places = {
            ...places,
            rooms: places.rooms.map((room) =>
              room.id === id ? { ...room, floorId } : room,
            ),
          };
          return places.rooms.find((room) => room.id === id);
        }
        case "/api/places/floors/order":
          return places.floors;
        case "/api/places/floors/remove":
          return undefined;
        case "/api/places/home":
          return { name: "Home", timeZone: null, coordinates: null };
        case "/api/auth/clients":
        case "/api/people":
        case "/api/entities":
          return [];
        default:
          return {};
      }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function show() {
    await act(async () =>
      root.render(
        <SettingsPage
          page="rooms"
          params={{}}
          onStarted={() => undefined}
          open={() => undefined}
          back={() => undefined}
          apps={apps}
          me={me}
          core={{ state: "online", version: "1.2.3" } as never}
          live={live}
          devices={{ devices: [], places: undefined }}
          home={unknownHome}
          onUpdating={() => undefined}
        />,
      ),
    );
  }

  const section = () =>
    container.querySelector<HTMLElement>("[aria-labelledby=settings-floors]")!;
  const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");
  const sent = (path: string) =>
    requests.filter((each) => each.path === path).map((each) => each.json);

  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function button(name: string) {
    const scope = dialog() ?? document;
    return [...scope.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === name,
    )!;
  }

  const check = (room: string) =>
    act(async () =>
      dialog()!
        .querySelector<HTMLButtonElement>(`#floor-room-${room}`)!
        .click(),
    );
  const isChecked = (room: string) =>
    dialog()!
      .querySelector(`#floor-room-${room}`)!
      .getAttribute("aria-checked") === "true";

  async function open(menu: string) {
    const trigger = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${menu}"]`,
    )!;
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
  }
  const item = (name: string) =>
    [
      ...document.querySelectorAll<HTMLElement>(
        "[role=menuitem], [role=menuitemradio]",
      ),
    ].find((candidate) => candidate.textContent === name)!;

  it("lists the floors in their order with the rooms on them, before the rooms", async () => {
    await show();
    expect(section().textContent).toContain("Ground floorHall and Kitchen");
    expect(section().textContent).toContain("First floorBedroom");
    const headings = [...container.querySelectorAll("h2")].map(
      (each) => each.textContent,
    );
    expect(headings.indexOf("Floors")).toBe(headings.indexOf("Rooms") - 1);
  });

  it("says what floors are for while the home has none", async () => {
    places = { ...places, floors: [], rooms: [office] };
    await show();
    expect(section().textContent).toContain(
      "Floors put rooms in order, such as Ground floor and First floor, and turn each floor's lights off at once.",
    );
    expect(button("Add floor")).toBeDefined();
  });

  it("adds a floor from a suggested name, with the rooms checked on it", async () => {
    await show();
    await act(async () => button("Add floor").click());
    expect(dialog()?.textContent).toContain("New floor");
    // The home has Ground floor and First floor already.
    const suggested = [
      ...dialog()!.querySelectorAll("[aria-label='Suggested names'] button"),
    ].map((each) => each.textContent);
    expect(suggested).toEqual(["Basement", "Outside"]);
    expect(button("Add").disabled).toBe(true);

    await act(async () => button("Outside").click());
    expect(dialog()!.querySelector("input")!.value).toBe("Outside");
    // Chosen, so it is no longer suggested.
    expect(button("Outside")).toBeUndefined();
    // A room on another floor says so, and checking it moves it.
    expect(dialog()!.textContent).toContain("HallOn Ground floor");
    await check("office");
    await check("hall");
    await act(async () => button("Add").click());

    expect(sent("/api/places/floors/add")).toEqual([{ name: "Outside" }]);
    expect(sent("/api/places/rooms/update")).toEqual([
      { id: "hall", floorId: "new-floor" },
      { id: "office", floorId: "new-floor" },
    ]);
    expect(dialog()).toBeNull();
    expect(section().textContent).toContain("OutsideHall and Office");
  });

  it("edits a floor's name and the rooms on it", async () => {
    await show();
    await open("Ground floor: more");
    await act(async () => item("Edit").click());
    expect(dialog()?.textContent).toContain("Edit floor");
    expect(isChecked("kitchen")).toBe(true);
    expect(isChecked("hall")).toBe(true);
    expect(isChecked("office")).toBe(false);

    await type(dialog()!.querySelector("input")!, "Downstairs");
    await check("hall");
    await act(async () => button("Save").click());

    expect(sent("/api/places/floors/update")).toEqual([
      { id: "ground", name: "Downstairs" },
    ]);
    expect(sent("/api/places/rooms/update")).toEqual([
      { id: "hall", floorId: null },
    ]);
  });

  it("retries room assignments without adding the floor a second time", async () => {
    const original = vi.mocked(coreJson).getMockImplementation()!;
    let hasFailed = false;
    vi.mocked(coreJson).mockImplementation(async (path, init) => {
      if (
        path === "/api/places/rooms/update" &&
        (init?.json as { id: string }).id === "office" &&
        !hasFailed
      ) {
        hasFailed = true;
        throw new Error("Connection lost");
      }
      return original(path, init);
    });
    await show();
    await act(async () => button("Add floor").click());
    await type(dialog()!.querySelector("input")!, "Outside");
    await check("hall");
    await check("office");
    await act(async () => button("Add").click());

    expect(dialog()!.querySelector("[role=alert]")?.textContent).toContain(
      "Try again.",
    );
    await type(dialog()!.querySelector("input")!, "Garden");
    await check("hall");
    await act(async () => button("Add").click());

    expect(sent("/api/places/floors/add")).toEqual([{ name: "Outside" }]);
    expect(places.floors.filter((floor) => floor.id === "new-floor")).toEqual([
      { id: "new-floor", name: "Garden", level: 2 },
    ]);
    expect(places.rooms.find((room) => room.id === "office")?.floorId).toBe(
      "new-floor",
    );
    expect(places.rooms.find((room) => room.id === "hall")?.floorId).toBeNull();
    expect(dialog()).toBeNull();
  });

  it("keeps a late floor save separate from the next editor opening", async () => {
    await show();
    await act(async () => button("Add floor").click());
    await type(dialog()!.querySelector("input")!, "Outside");
    let finish!: () => void;
    const answer = new Promise<void>((resolve) => (finish = resolve));
    vi.mocked(coreJson).mockImplementationOnce(async () => {
      await answer;
      const floor = { id: "outside", name: "Outside", level: 2 };
      places = { ...places, floors: [...places.floors, floor] };
      return floor;
    });
    await act(async () => button("Add").click());
    await act(async () => button("Cancel").click());
    await act(async () => button("Add floor").click());
    await type(dialog()!.querySelector("input")!, "Basement");

    await act(async () => finish());
    expect(dialog()!.querySelector("input")!.value).toBe("Basement");
    expect(button("Add").disabled).toBe(false);
    await act(async () => button("Add").click());

    expect(places.floors.map((floor) => floor.name)).toEqual([
      "Ground floor",
      "First floor",
      "Outside",
      "Basement",
    ]);
    expect(sent("/api/places/floors/update")).toEqual([]);
    expect(dialog()).toBeNull();
  });

  it("saves only the room choices changed in the editor over live changes", async () => {
    await show();
    await open("Ground floor: more");
    await act(async () => item("Edit").click());
    await type(dialog()!.querySelector("input")!, "Downstairs");
    await check("hall");

    places = {
      ...places,
      rooms: [
        { ...bedroom, floorId: "ground" },
        hall,
        { ...kitchen, floorId: "first" },
        office,
        { id: "studio", name: "Studio", floorId: "ground" },
      ],
    };
    await act(async () => live.publish({ type: "places", places }));
    await act(async () => button("Save").click());

    expect(sent("/api/places/rooms/update")).toEqual([
      { id: "hall", floorId: null },
    ]);
    expect(places.rooms.find((room) => room.id === "kitchen")?.floorId).toBe(
      "first",
    );
    expect(places.rooms.find((room) => room.id === "bedroom")?.floorId).toBe(
      "ground",
    );
    expect(places.rooms.find((room) => room.id === "studio")?.floorId).toBe(
      "ground",
    );
  });

  it("moves a floor with the arrow keys from its grip, saying where it went", async () => {
    await show();
    const grip = document.querySelector<HTMLButtonElement>(
      "button[aria-label='Move Ground floor']",
    )!;
    grip.focus();
    await act(async () =>
      grip.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );

    expect(sent("/api/places/floors/order")).toEqual([
      { ids: ["first", "ground"] },
    ]);
    expect(section().textContent).toMatch(/First floor.*Ground floor/);
    expect(section().querySelector("[role=status]")?.textContent).toBe(
      "Ground floor, 2 of 2",
    );
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Move Ground floor",
    );

    // Already last: nothing to send.
    await act(async () =>
      grip.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
      ),
    );
    expect(sent("/api/places/floors/order")).toHaveLength(1);
  });

  it("keeps a floor added live during a drag in the saved order", async () => {
    await show();
    const grip = document.querySelector<HTMLButtonElement>(
      "button[aria-label='Move Ground floor']",
    )!;
    const row = document
      .querySelector("button[aria-label='Move First floor']")!
      .closest("li")!;
    row.getBoundingClientRect = () => ({ top: 40, bottom: 80 }) as DOMRect;
    const pointer = (type: string, y: number) =>
      act(async () => {
        const event = new MouseEvent(type, {
          button: 0,
          clientY: y,
          bubbles: true,
        });
        Object.defineProperty(event, "pointerId", { value: 1 });
        grip.dispatchEvent(event);
      });
    await pointer("pointerdown", 10);
    places = {
      ...places,
      floors: [...places.floors, { id: "outside", name: "Outside", level: 2 }],
    };
    await act(async () => live.publish({ type: "places", places }));
    expect(section().textContent).toContain("Outside");

    await pointer("pointermove", 60);
    const added = document
      .querySelector("button[aria-label='Move Outside']")!
      .closest("li")!;
    added.getBoundingClientRect = () => ({ top: 80, bottom: 120 }) as DOMRect;
    await pointer("pointermove", 100);
    await pointer("pointerup", 100);

    expect(sent("/api/places/floors/order")).toEqual([
      { ids: ["first", "outside", "ground"] },
    ]);
    expect(section().textContent).toMatch(/First floor.*Outside.*Ground floor/);
  });

  it("puts a room on a floor from its menu, or starts a new floor with it", async () => {
    await show();
    await open("Office: more");
    const floor = item("Floor");
    await act(async () => {
      floor.focus();
      floor.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(item("No floor").getAttribute("aria-checked")).toBe("true");
    await act(async () => item("First floor").click());
    expect(sent("/api/places/rooms/update")).toEqual([
      { id: "office", floorId: "first" },
    ]);

    await open("Hall: more");
    const again = item("Floor");
    await act(async () => {
      again.focus();
      again.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    await act(async () => item("New floor…").click());
    expect(dialog()?.textContent).toContain("New floor");
    expect(isChecked("hall")).toBe(true);
  });

  it("removes a floor once it has said what goes with it", async () => {
    removal = {
      rooms: [
        { id: "hall", name: "Hall" },
        { id: "kitchen", name: "Kitchen" },
      ],
      workflows: [{ id: "w", name: "Downstairs off" }],
    };
    await show();
    await open("Ground floor: more");
    await act(async () => item("Remove").click());

    expect(dialog()?.textContent).toContain("Remove Ground floor?");
    expect(dialog()?.textContent).toContain(
      "Hall and Kitchen stay, on no floor.",
    );
    expect(dialog()?.textContent).toContain(
      "The workflow “Downstairs off” uses it and will need changing.",
    );
    await act(async () => button("Remove floor").click());

    expect(sent("/api/places/floors/remove")).toEqual([{ id: "ground" }]);
    expect(section().textContent).not.toContain("Ground floor");
    const rooms = container.querySelector<HTMLElement>(
      "[aria-labelledby=settings-rooms]",
    )!;
    expect(rooms.textContent).toContain("KitchenNo devices");
  });
});

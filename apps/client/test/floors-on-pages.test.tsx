// @vitest-environment jsdom
import type { DeviceInfo, Places } from "@meetsanctum/app-sdk";
import { deviceTypeOf } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { useDashboards } from "../src/dashboards";
import { byFloor } from "../src/floor-groups";
import { HomeRooms } from "../src/home-dashboard";
import { CategoryPage } from "../src/place-pages";
import { useSectionEntities } from "../src/room-sections";
import { getShell } from "../src/shell";
import { SidebarRooms } from "../src/sidebar-rooms";
import { useDevices } from "../src/use-devices";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

// Floors on Home, Lights' page and the sidebar: rooms under their floors in
// the household's order, then those on none; a floor's button that turns
// its lights off while any is on; and floors folding in the sidebar, which
// each device remembers.

const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  // In the household's order.
  floors: [
    { id: "first", name: "First floor", level: 0 },
    { id: "ground", name: "Ground floor", level: 1 },
  ],
  zones: [],
  rooms: [
    { id: "bedroom", name: "Bedroom", floorId: "first" },
    { id: "hall", name: "Hall", floorId: "ground" },
    { id: "kitchen", name: "Kitchen", floorId: "ground" },
    { id: "shed", name: "Shed", floorId: null },
  ],
};

const light = (
  id: string,
  name: string,
  roomId: string | null,
  on = false,
): DeviceInfo => {
  const capabilities = [
    {
      id: "light",
      kind: "light",
      features: { brightness: true, colorTemperature: null, color: false },
      state: { on, brightness: 40 },
      observed: { on, brightness: 40 },
      desired: null,
      sync: "synced",
      setBy: null,
      changedAt: null,
    },
  ] as unknown as DeviceInfo["capabilities"];
  return {
    id,
    name,
    driverName: name,
    type: deviceTypeOf(["light"]),
    driver: "sanctum.zigbee",
    manufacturer: null,
    model: null,
    roomId,
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
    capabilities,
  };
};

const devices = [
  light("pendant", "Pendant", "kitchen", true),
  light("ceiling", "Ceiling", "hall", true),
  light("bedside", "Bedside", "bedroom"),
  light("shed-light", "Shed light", "shed"),
  light("loose", "Loose lamp", null),
];

let root: Root;
let container: HTMLDivElement;
let live: ReturnType<typeof createLiveFeed>;

function HomeHarness() {
  const shown = useDevices(live);
  const entities = useSectionEntities(live, [], shown.fail);
  const { home } = useDashboards(live);
  return (
    <HomeRooms
      devices={shown}
      onHome={home.devices}
      homeName={home.name}
      apps={[]}
      entities={entities}
      openRoom={() => {}}
      openNoRoom={() => {}}
      openDevice={() => {}}
      onEdit={() => {}}
    />
  );
}

function LightsHarness() {
  const shown = useDevices(live);
  return (
    <CategoryPage
      id="lights"
      devices={shown}
      openDevice={() => {}}
      openRoom={() => {}}
      back={() => {}}
    />
  );
}

async function show(element: React.ReactElement) {
  await act(async () => root.render(element));
  await act(async () => live.refresh());
}

// Each floor's heading, then its rooms' headings, in order.
const outline = () =>
  [...container.querySelectorAll("h2, h3")].map(
    (each) => `${each.tagName.toLowerCase()} ${each.textContent}`,
  );
const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (each) => each.getAttribute("aria-label") === label,
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  live = createLiveFeed();
  localStorage.clear();
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path === "/api/devices") return devices;
    if (path === "/api/places") return places;
    if (path.startsWith("/api/entities?")) return [];
    if (path === "/api/devices/lights") {
      return { on: false, switched: 2, failed: [] };
    }
    const home = {
      id: "home",
      name: "Home",
      background: "mocha",
      kind: "home",
      devices: devices.map((each) => each.id),
    };
    return path === "/api/dashboards" ? [home] : home;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("rooms by floor", () => {
  it("are none while the home has no floors", () => {
    expect(
      byFloor({ ...places, floors: [] }, ["hall"], (room) => room),
    ).toBeNull();
  });

  it("follow the floors' order, then the rooms on none, leaving out empty floors", () => {
    expect(
      byFloor(places, ["shed", "kitchen", null, "hall"], (room) => room)?.map(
        (group) => [group.floor?.name ?? null, group.items],
      ),
    ).toEqual([
      ["Ground floor", ["kitchen", "hall"]],
      [null, ["shed", null]],
    ]);
  });
});

describe("Home with floors", () => {
  it("heads the rooms with their floors, then Other rooms, rooms a level down", async () => {
    await show(<HomeHarness />);
    expect(outline()).toEqual([
      "h2 First floor",
      "h3 Bedroom",
      "h2 Ground floor",
      "h3 Hall",
      "h3 Kitchen",
      "h2 Other rooms",
      "h3 Shed",
      "h3 No room",
    ]);
  });

  it("turns a floor's lights off from its heading, while any is on", async () => {
    await show(<HomeHarness />);
    const off = button("Turn off 2 lights on Ground floor");
    expect(off?.textContent).toBe("Turn off");
    // All off upstairs: its heading is its name alone.
    expect(button("Turn off 1 light on First floor")).toBeUndefined();
    expect(container.textContent).not.toContain("First floorTurn");

    await act(async () => off!.click());
    expect(
      vi
        .mocked(coreJson)
        .mock.calls.filter(([path]) => path === "/api/devices/lights")
        .map(([, init]) => init?.json),
    ).toEqual([{ place: { kind: "floor", id: "ground" }, to: "off" }]);
  });
});

describe("Lights' page with floors", () => {
  it("heads its rooms by floor, each floor with its button and each room with its own", async () => {
    await show(<LightsHarness />);
    expect(outline()).toEqual([
      "h2 First floor",
      "h3 Bedroom",
      "h2 Ground floor",
      "h3 Hall",
      "h3 Kitchen",
      "h2 Other rooms",
      "h3 Shed",
      "h3 No room",
    ]);
    expect(button("Turn off 2 lights on Ground floor")).toBeDefined();
    expect(button("Turn off 1 light in Kitchen")).toBeDefined();
    expect(button("Turn on lights in Bedroom")).toBeDefined();
  });
});

describe("the sidebar's floors", () => {
  const open = vi.fn();
  async function sidebar(currentRoom: string | null = null) {
    await act(async () =>
      root.render(
        <nav>
          <SidebarRooms
            places={places}
            currentRoom={currentRoom}
            hasNoRoom
            isNoRoomCurrent={false}
            openRoom={open}
            openNoRoom={() => {}}
          />
        </nav>,
      ),
    );
  }
  const rows = () =>
    [...container.querySelectorAll("button")].map((each) => {
      const nested = each.closest("[role=group]") ? "  " : "";
      return `${nested}${each.textContent}`;
    });
  const floorRow = (name: string) =>
    [...container.querySelectorAll("button[aria-expanded]")].find((each) =>
      each.textContent?.startsWith(name),
    ) as HTMLButtonElement;

  it("indents each floor's rooms under it, then the rooms on none and No room", async () => {
    await sidebar();
    expect(rows()).toEqual([
      "First floor",
      "  Bedroom",
      "Ground floor",
      "  Hall",
      "  Kitchen",
      "Shed",
      "No room",
    ]);
    expect(floorRow("Ground floor").getAttribute("aria-expanded")).toBe("true");
  });

  it("folds a floor's rooms away, says how many it holds, and keeps that on the device", async () => {
    await sidebar("kitchen");
    await act(async () => floorRow("Ground floor").click());
    expect(rows()).toEqual([
      "First floor",
      "  Bedroom",
      "Ground floor2",
      "Shed",
      "No room",
    ]);
    // It holds the page on show, so it is drawn as the current place.
    expect(floorRow("Ground floor").getAttribute("aria-current")).toBe("page");
    expect(floorRow("Ground floor").getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(
      localStorage.getItem("sanctum.preference.sidebar.folded-floors"),
    ).toBe('["ground"]');

    // Another start of the sidebar keeps it folded.
    await act(async () => root.render(<nav />));
    await sidebar("kitchen");
    await act(async () => {});
    expect(rows()).toContain("Ground floor2");
  });

  it("keeps folds with a key the desktop preference store accepts", async () => {
    const saved = new Map<string, string>();
    const preferences = getShell().preferences;
    vi.spyOn(preferences, "get").mockImplementation(
      async (key) => saved.get(key) ?? null,
    );
    vi.spyOn(preferences, "set").mockImplementation(async (key, value) => {
      if (!/^[a-z][a-z0-9.-]{0,63}$/.test(key)) {
        throw new TypeError("Not a preference to keep");
      }
      saved.set(key, value);
    });
    await sidebar();
    await act(async () => floorRow("Ground floor").click());
    await act(async () => root.render(<nav />));
    await sidebar();
    expect(floorRow("Ground floor").getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("preserves an early fold and the other saved folds when preferences arrive late", async () => {
    let answer!: (value: string | null) => void;
    vi.spyOn(getShell().preferences, "get").mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    await sidebar();
    await act(async () => floorRow("Ground floor").click());
    await act(async () => answer('["first"]'));
    expect(floorRow("Ground floor").getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(floorRow("First floor").getAttribute("aria-expanded")).toBe("false");
    await act(async () => root.render(<nav />));
    await sidebar();
    expect(floorRow("Ground floor").getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(floorRow("First floor").getAttribute("aria-expanded")).toBe("false");
  });
});

// @vitest-environment jsdom
import type {
  AppInfo,
  DeviceInfo,
  EntityInfo,
  Places,
} from "@meetsanctum/app-sdk";
import { deviceTypeOf } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { useDashboards } from "../src/dashboards";
import { EditHome } from "../src/edit-home";
import { HomeRooms } from "../src/home-dashboard";
import { useSectionEntities } from "../src/room-sections";
import { useDevices } from "../src/use-devices";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

// Home: each room with its lights, what it reads, its moods and what the
// household put on Home, in the household's order, and Edit Home, which
// changes that through the core.

const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  zones: [],
  // In the core's order, by name.
  rooms: [
    { id: "attic", name: "Attic", floorId: null },
    { id: "hall", name: "Hall", floorId: null },
    { id: "office", name: "Office", floorId: null },
  ],
};

function device(
  id: string,
  name: string,
  roomId: string | null,
  capabilities: DeviceInfo["capabilities"],
): DeviceInfo {
  return {
    id,
    name,
    driverName: name,
    type: deviceTypeOf(capabilities.map((each) => each.kind)),
    driver: "sanctum.zigbee",
    manufacturer: null,
    model: null,
    roomId,
    availability: "online",
    lastSeenAt: null,
    firmware: null,
    probe: false,
    battery: null,
    leftAt: null,
    capabilities,
  };
}
const capability = <T extends DeviceInfo["capabilities"][number]["kind"]>(
  kind: T,
  id: string,
  features: unknown,
  state: Record<string, unknown>,
) =>
  ({
    id,
    kind,
    features,
    state,
    observed: state,
    desired: null,
    sync: "synced",
    setBy: null,
    changedAt: null,
  }) as unknown as DeviceInfo["capabilities"][number];
const light = (id: string, name: string, roomId: string | null, on = false) =>
  device(id, name, roomId, [
    capability(
      "light",
      "light",
      { brightness: true, colorTemperature: null, color: false },
      { on, brightness: 40 },
    ),
  ]);

const lamp = light("lamp", "Lamp", "office", true);
const desk = light("desk", "Desk strip", "office");
const kettle = device("kettle", "Kettle", "office", [
  capability("switch", "power", {}, { on: false }),
]);
const climate = device("climate", "Office sensor", "office", [
  capability(
    "sensor",
    "temperature",
    { measures: "temperature" },
    { value: 21.5 },
  ),
]);
const ceiling = light("ceiling", "Ceiling", "hall");
const loose = light("loose", "Loose lamp", null);

const moods: AppInfo = {
  id: "sanctum.moods",
  name: "Moods",
  version: "0.1.0",
  icon: { glyph: "sparkles", color: "ember" },
  pages: ["room"],
  permissions: [],
  requests: [],
  state: "running",
  settings: null,
  provides: {
    entities: [],
    widgets: [],
    roomSections: [
      {
        id: "moods.room",
        title: "Moods",
        entityType: "moods.mood",
        kind: "tiles",
        order: 200,
        press: { action: "moods.runMood" },
        open: { page: "room", label: "Edit" },
        whenEmpty: { roomHas: "light" },
      },
    ],
    devicePages: [],
  },
};
const relax: EntityInfo = {
  app: "sanctum.moods",
  key: "relax",
  type: "moods.mood",
  name: "Relax",
  state: {
    placeId: "office",
    name: "Relax",
    icon: "armchair",
    order: 0,
    active: false,
    input: { id: "relax" },
  },
  updatedAt: "2026-11-02T10:00:00.000Z",
};

let root: Root;
let container: HTMLDivElement;
let live: ReturnType<typeof createLiveFeed>;
let devices: DeviceInfo[];
// Home's devices, as the core keeps them.
let onHome: string[];
const openRoom = vi.fn();
const onEdit = vi.fn();

function Harness(props: { editing: boolean }) {
  const shown = useDevices(live);
  const entities = useSectionEntities(live, [moods], shown.fail);
  const { home } = useDashboards(live);
  return props.editing ? (
    <EditHome devices={shown} home={home} />
  ) : (
    <HomeRooms
      devices={shown}
      onHome={home.devices}
      homeName={home.name}
      apps={[moods]}
      entities={entities}
      openRoom={openRoom}
      openDevice={() => {}}
      onEdit={onEdit}
    />
  );
}

async function show(editing = false) {
  await act(async () => {
    root.render(<Harness editing={editing} />);
  });
  await act(async () => {
    live.refresh();
  });
}

const sections = () =>
  [...container.querySelectorAll("section")].map((section) => ({
    heading: section.querySelector("h2")?.textContent,
    groups: [...section.querySelectorAll("[role=group]")].map((group) => [
      group.getAttribute("aria-label"),
      ...[...group.querySelectorAll(":scope > *")].map(
        (each) =>
          each.querySelector(".truncate.text-sm")?.textContent ??
          each.textContent,
      ),
    ]),
  }));
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find(
    (each) =>
      each.getAttribute("aria-label") === label || each.textContent === label,
  );
  if (!found) throw new Error(`No button ${label}`);
  return found;
};
const posted = (path: string) =>
  vi
    .mocked(coreJson)
    .mock.calls.filter(([each]) => each === path)
    .map(([, init]) => init?.json);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  live = createLiveFeed();
  devices = [lamp, desk, kettle, climate, ceiling, loose];
  // The hall's ceiling light was taken off; the desk strip comes first.
  onHome = ["desk", "lamp", "loose"];
  openRoom.mockReset();
  onEdit.mockReset();
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init) => {
    const asked = init?.json as { device?: string; devices?: string[] };
    if (path === "/api/devices") return devices;
    if (path === "/api/places") return places;
    if (path.startsWith("/api/entities?")) return [relax];
    if (path === "/api/dashboards") {
      return [
        {
          id: "home",
          name: "Home",
          background: "mocha",
          kind: "home",
          devices: onHome,
        },
      ];
    }
    if (path === "/api/dashboards/home/add") {
      onHome = [...onHome, asked.device!];
    } else if (path === "/api/dashboards/home/remove") {
      onHome = onHome.filter((each) => each !== asked.device);
    } else if (path === "/api/dashboards/home/order") {
      const at = asked
        .devices!.map((each) => onHome.indexOf(each))
        .sort((a, b) => a - b);
      onHome = [...onHome];
      at.forEach((index, order) => (onHome[index] = asked.devices![order]!));
    }
    return {
      id: "home",
      name: "Home",
      background: "mocha",
      kind: "home",
      devices: onHome,
    };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
});

describe("Home", () => {
  it("shows each room with something to show, its lights, readings, moods and what is on Home in order", async () => {
    await show();

    // The attic has nothing, and devices with no room come last.
    expect(sections()).toEqual([
      { heading: "Hall", groups: [] },
      {
        heading: "Office",
        groups: [
          ["Moods", "Relax"],
          ["On Home", "Desk strip", "Lamp"],
        ],
      },
      { heading: "Not in a room", groups: [["On Home", "Loose lamp"]] },
    ]);
    // The hall's light is off Home, but its room's button is there.
    expect(button("Turn on the Hall lights").textContent).toBe("Lights off");
    expect(button("Turn off the Office lights").textContent).toBe("1 Light on");
    expect(
      container.querySelector("[data-slot=readings]")?.textContent,
    ).toContain("21.5°");
    expect(container.textContent).not.toContain("Kettle");
  });

  it("opens a room's page from its name", async () => {
    await show();
    await act(async () => button("Office").click());
    expect(openRoom).toHaveBeenCalledWith("office");
  });

  it("says how to put something on it while nothing is", async () => {
    onHome = [];
    await show();

    expect(container.textContent).toContain("Nothing is on Home yet");
    await act(async () => button("Edit Home").click());
    expect(onEdit).toHaveBeenCalled();
  });
});

describe("Edit Home", () => {
  it("keeps devices without tiles available to remove and reorder", async () => {
    devices.push(device("unknown", "Unknown device", "office", []));
    await show(true);
    await act(async () => button("Add Unknown device to Home").click());
    expect(button("Remove Unknown device from Home")).toBeDefined();
    expect(button("Move Unknown device")).toBeDefined();
    await act(async () => button("Remove Unknown device from Home").click());
    expect(onHome).not.toContain("unknown");
  });

  it("shows each room's devices on Home in order, then those that are not", async () => {
    await show(true);

    expect(sections()).toEqual([
      { heading: "Hall", groups: [["Hall, not on Home", "Ceiling"]] },
      {
        heading: "Office",
        groups: [
          ["Office on Home", "Desk strip", "Lamp"],
          ["Office, not on Home", "Kettle", "Office sensor"],
        ],
      },
      {
        heading: "Not in a room",
        groups: [["Not in a room on Home", "Loose lamp"]],
      },
    ]);
    expect(container.textContent).toContain("Nothing in Hall is on Home.");
  });

  it("takes a device off Home and puts another on, through the core", async () => {
    await show(true);

    await act(async () => button("Remove Lamp from Home").click());
    await act(async () => button("Add Kettle to Home").click());

    expect(posted("/api/dashboards/home/remove")).toEqual([{ device: "lamp" }]);
    expect(posted("/api/dashboards/home/add")).toEqual([{ device: "kettle" }]);
    expect(sections()[1]!.groups).toEqual([
      ["Office on Home", "Desk strip", "Kettle"],
      ["Office, not on Home", "Lamp", "Office sensor"],
    ]);
  });

  it.each(["Desk strip", "Loose lamp"])(
    "keeps a fast mouse drag attached to its original device and room over %s",
    async (targetName) => {
      await show(true);
      const source = button("Move Lamp").parentElement!;
      const target = button(`Move ${targetName}`).parentElement!;
      vi.spyOn(target, "getBoundingClientRect").mockReturnValue({
        left: 100,
        right: 200,
        top: 0,
        bottom: 50,
      } as DOMRect);
      const pointer = (element: Element, type: string, x: number) => {
        const event = new MouseEvent(type, {
          bubbles: true,
          button: 0,
          buttons: type === "pointerup" ? 0 : 1,
          clientX: x,
          clientY: 20,
        });
        Object.defineProperty(event, "pointerId", { value: 1 });
        element.dispatchEvent(event);
      };
      await act(async () => pointer(source, "pointerdown", 0));
      // A mouse can reach the next tile before the first move event is
      // handled and pointer capture begins.
      await act(async () => pointer(target, "pointermove", 120));
      if (targetName === "Desk strip") {
        expect(source.hasAttribute("data-dragging")).toBe(true);
        expect(target.hasAttribute("data-dragging")).toBe(false);
      }
      await act(async () => pointer(target, "pointerup", 120));
      expect(posted("/api/dashboards/home/order")).toEqual(
        targetName === "Desk strip" ? [{ devices: ["lamp", "desk"] }] : [],
      );
    },
  );

  it("moves a device within its room with the arrow keys, keeping focus on it", async () => {
    await show(true);
    const grip = button("Move Lamp");
    grip.focus();

    await act(async () => {
      grip.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
    });

    expect(posted("/api/dashboards/home/order")).toEqual([
      { devices: ["lamp", "desk"] },
    ]);
    expect(sections()[1]!.groups[0]).toEqual([
      "Office on Home",
      "Lamp",
      "Desk strip",
    ]);
    expect(document.activeElement).toBe(button("Move Lamp"));
    expect(container.querySelector("[role=status]")?.textContent).toBe(
      "Lamp, 1 of 2",
    );
    // The first stays first.
    await act(async () => {
      button("Move Lamp").dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }),
      );
    });
    expect(posted("/api/dashboards/home/order")).toHaveLength(1);
  });
});

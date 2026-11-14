// @vitest-environment jsdom
import type {
  AppInfo,
  DeviceInfo,
  Places,
  RoomRemoval,
} from "@meetsanctum/app-sdk";
import type { Me } from "@meetsanctum/auth-protocol";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreError, coreJson } from "../src/core-fetch";
import { SettingsPage } from "../src/settings";
import { counted, removalWarning, roomDetail } from "../src/settings-rooms";
import { unknownHome } from "./home-fixtures";

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const ground = { id: "ground", name: "Ground floor", level: 0 };
const kitchen = { id: "kitchen", name: "Kitchen", floorId: "ground" };
const office = { id: "office", name: "Office", floorId: null };
function device(id: string, name: string, roomId: string | null) {
  return {
    id,
    name,
    driverName: name,
    type: "unknown",
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
    problem: null,
    capabilities: [],
  } satisfies DeviceInfo;
}
const nothing: RoomRemoval = { devices: [], entities: [], workflows: [] };
const maya = {
  id: "maya",
  name: "Maya",
  avatar: null,
  colour: "#c5cdac",
} as const;
const macbook = {
  id: "macbook",
  name: "Maya's MacBook",
  kind: "personal",
  platform: "macos",
  personId: "maya",
  createdAt: "2026-10-26T12:00:00Z",
  lastSeenAt: "2026-10-28T11:59:30Z",
  connectedSince: null,
  current: true,
} as const;
const admin: Me = { client: macbook, person: maya };
const apps: AppInfo[] = [];

describe("a room's line", () => {
  it("names its floor and counts its devices", () => {
    const devices = [
      device("lamp", "Lamp", "kitchen"),
      device("plug", "Plug", "kitchen"),
      device("desk", "Desk", "office"),
    ];
    expect(roomDetail(kitchen, [ground], devices)).toBe(
      "Ground floor · 2 devices",
    );
    expect(roomDetail(office, [ground], devices)).toBe("1 device");
    expect(roomDetail(office, [ground], [])).toBe("No devices");
  });
});

describe("what removing a room says", () => {
  it("counts what apps keep for it by their types' titles", () => {
    expect(counted(4, "Mood")).toBe("4 moods");
    expect(counted(1, "Mood")).toBe("1 mood");
    expect(counted(2, "Battery")).toBe("2 batteries");
    expect(counted(3, "Switch")).toBe("3 switches");
    expect(counted(2, "CO2 sensor")).toBe("2 CO2 sensors");
  });

  it("names its devices, what apps keep for it and the workflows that use it", () => {
    expect(
      removalWarning({
        devices: [{ id: "lamp", name: "Kitchen light" }],
        entities: [{ app: "a", type: "moods.mood", title: "Mood", count: 1 }],
        workflows: [{ id: "w", name: "Night" }],
      }),
    ).toEqual([
      "Kitchen light moves to No room and stays paired.",
      "1 mood goes with it.",
      "The workflow “Night” uses it and will need changing.",
    ]);
    expect(
      removalWarning({
        devices: [
          { id: "lamp", name: "Kitchen light" },
          { id: "plug", name: "Kettle" },
        ],
        entities: [
          { app: "a", type: "moods.mood", title: "Mood", count: 4 },
          { app: "b", type: "awnings.awning", title: "Awning", count: 1 },
        ],
        workflows: [
          { id: "m", name: "Morning" },
          { id: "n", name: "Night" },
        ],
      }),
    ).toEqual([
      "Its 2 devices move to No room and stay paired.",
      "4 moods and 1 awning go with it.",
      "The workflows “Morning” and “Night” use it and will need changing.",
    ]);
    expect(removalWarning(nothing)).toEqual([]);
  });
});

describe("Settings → Rooms", () => {
  let root: Root;
  let container: HTMLDivElement;
  let places: Places;
  let devices: DeviceInfo[];
  let removal: RoomRemoval;
  let requests: { path: string; json?: unknown }[];
  const live = createLiveFeed();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    places = {
      home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
      floors: [ground],
      rooms: [kitchen, office],
      zones: [],
    };
    devices = [
      device("lamp", "Kitchen light", "kitchen"),
      device("plug", "Kettle", "kitchen"),
    ];
    removal = nothing;
    requests = [];
    vi.mocked(coreJson).mockReset();
    vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
      requests.push({ path, json: init.json });
      if (path.startsWith("/api/places/rooms/removal?")) return removal;
      // Settings shows the activity log's newest entries too.
      if (path.startsWith("/api/activity?"))
        return { entries: [], more: false };
      switch (path) {
        case "/api/places":
          return places;
        case "/api/devices":
          return devices;
        // The core keeps what changed, which the page reads again.
        case "/api/places/rooms/add": {
          const { name } = init.json as { name: string };
          const room = { id: name.toLowerCase(), name, floorId: null };
          places = { ...places, rooms: [...places.rooms, room] };
          return room;
        }
        case "/api/places/rooms/update": {
          const { id, name } = init.json as { id: string; name: string };
          places = {
            ...places,
            rooms: places.rooms.map((room) =>
              room.id === id ? { ...room, name } : room,
            ),
          };
          return places.rooms.find((room) => room.id === id);
        }
        case "/api/places/rooms/remove":
          return undefined;
        // What the rest of Settings asks for.
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

  const started = vi.fn();
  async function show(me: Me, start?: "add-room") {
    await act(async () =>
      root.render(
        <SettingsPage
          page="main"
          params={{}}
          start={start}
          onStarted={started}
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
    container.querySelector<HTMLElement>("[aria-labelledby=settings-rooms]")!;
  const dialog = () => document.querySelector<HTMLElement>("[role=dialog]");

  // Sets an input's value the way typing does, so React sees it.
  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  // A button in the open dialog, if there is one: other sections of
  // Settings have buttons of the same name, such as Devices' Remove.
  function button(name: string) {
    const scope = dialog() ?? document;
    return [...scope.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === name,
    )!;
  }

  async function choose(menu: string, item: string) {
    const trigger = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${menu}"]`,
    )!;
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    const found = [
      ...document.querySelectorAll<HTMLElement>("[role=menuitem]"),
    ].find((candidate) => candidate.textContent === item)!;
    await act(async () => found.click());
  }

  it("is for every client, shared ones too", async () => {
    await show(admin);
    expect(section().textContent).toContain("Add room");

    await show({
      client: { ...macbook, kind: "shared", personId: null },
      person: null,
    } as unknown as Me);
    expect(section().textContent).toContain("Add room");
  });

  it("opens with Add room for the dashboard's setup, showing the section", async () => {
    const scrolled = vi.fn();
    started.mockClear();
    Element.prototype.scrollIntoView = scrolled;

    await show(admin, "add-room");

    expect(dialog()?.textContent).toContain("Add a room");
    expect(scrolled.mock.contexts).toEqual([
      document.getElementById("settings-rooms"),
    ]);
    expect(started).toHaveBeenCalledOnce();
  });

  it("lists the rooms with their floor and devices, and follows them live", async () => {
    await show(admin);
    expect(section().textContent).toContain("KitchenGround floor · 2 devices");
    expect(section().textContent).toContain("OfficeNo devices");

    await act(async () => {
      live.publish({
        type: "places",
        places: { ...places, rooms: [{ ...office, name: "Study" }] },
      });
      live.publish({
        type: "device",
        id: "lamp",
        device: device("lamp", "Desk light", "office"),
      });
    });
    expect(section().textContent).not.toContain("Kitchen");
    expect(section().textContent).toContain("Study1 device");

    await act(async () =>
      live.publish({ type: "places", places: { ...places, rooms: [] } }),
    );
    expect(section().textContent).toContain("No rooms yet.");
  });

  it("adds a room and renames one", async () => {
    await show(admin);
    await act(async () => button("Add room").click());
    expect(button("Add").disabled).toBe(true);
    await type(dialog()!.querySelector("input")!, "  Attic ");
    await act(async () => button("Add").click());

    expect(requests).toContainEqual({
      path: "/api/places/rooms/add",
      json: { name: "Attic" },
    });
    expect(dialog()).toBeNull();
    expect(section().textContent).toContain("AtticNo devices");

    await choose("Office: more", "Rename");
    expect(dialog()!.querySelector("input")!.value).toBe("Office");
    await type(dialog()!.querySelector("input")!, "Study");
    await act(async () => button("Save").click());

    expect(requests).toContainEqual({
      path: "/api/places/rooms/update",
      json: { id: "office", name: "Study" },
    });
    expect(section().textContent).toContain("Study");
    expect(section().textContent).not.toContain("Office");
  });

  it("recovers from a failed initial load when a places snapshot arrives", async () => {
    const original = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation(async (path, init) => {
      if (path === "/api/places") throw new Error("Connection lost");
      return original(path, init);
    });
    await show(admin);
    expect(section().textContent).not.toContain("Kitchen");

    await act(async () => {
      live.publish({ type: "places", places });
      live.publish({ type: "device", id: "lamp", device: devices[0]! });
    });

    expect(section().textContent).toContain("KitchenGround floor · 1 device");
    await choose("Kitchen: more", "Rename");
    expect(dialog()!.querySelector("input")!.value).toBe("Kitchen");
  });

  it("keeps live changes that arrive before a refresh finishes", async () => {
    await show(admin);
    let resolve!: (places: Places) => void;
    const answer = new Promise<Places>((done) => (resolve = done));
    const original = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation(async (path, init) => {
      if (path === "/api/places") return answer;
      return original(path, init);
    });
    await act(async () => {
      live.refresh();
      live.publish({
        type: "places",
        places: { ...places, rooms: [{ ...office, name: "Study" }] },
      });
      live.publish({
        type: "device",
        id: "lamp",
        device: device("lamp", "Desk light", "office"),
      });
    });
    await act(async () => resolve(places));

    expect(section().textContent).toContain("Study1 device");
    expect(section().textContent).not.toContain("Kitchen");
  });

  it("says what goes with a room before removing it", async () => {
    removal = {
      devices: [
        { id: "plug", name: "Kettle" },
        { id: "lamp", name: "Kitchen light" },
      ],
      entities: [
        { app: "sanctum.moods", type: "moods.mood", title: "Mood", count: 4 },
      ],
      workflows: [{ id: "night", name: "Night" }],
    };
    await show(admin);
    await choose("Kitchen: more", "Remove");

    expect(requests).toContainEqual({
      path: "/api/places/rooms/removal?id=kitchen",
      json: undefined,
    });
    expect(dialog()!.textContent).toContain("Remove Kitchen?");
    expect(dialog()!.textContent).toContain(
      "Apps remove any content they keep for this room.",
    );
    expect(dialog()!.textContent).toContain(
      "Its 2 devices move to No room and stay paired.",
    );
    expect(dialog()!.textContent).toContain("4 moods go with it.");
    expect(dialog()!.textContent).toContain(
      "The workflow “Night” uses it and will need changing.",
    );

    await act(async () => button("Remove").click());

    expect(requests).toContainEqual({
      path: "/api/places/rooms/remove",
      json: { id: "kitchen" },
    });
    expect(dialog()).toBeNull();
    expect(section().textContent).not.toContain("Kitchen");
  });

  it("warns about app content even when the preview lists nothing", async () => {
    await show(admin);
    await choose("Office: more", "Remove");

    expect(dialog()!.textContent).toContain(
      "Apps remove any content they keep for this room.",
    );
    expect(dialog()!.textContent).not.toContain("Nothing else goes with it.");
    expect(button("Remove").disabled).toBe(false);
  });

  it("removes nothing until it can say what goes with the room", async () => {
    const original = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation(async (path, init) => {
      if (path.startsWith("/api/places/rooms/removal?")) {
        throw new CoreError(404, "not_found");
      }
      return original(path, init);
    });
    await show(admin);
    await choose("Office: more", "Remove");

    expect(dialog()!.textContent).toContain(
      "Sanctum could not say what goes with it.",
    );
    expect(dialog()!.querySelector("[role=alert]")!.textContent).toBe(
      "That room is not there any more.",
    );
    expect(button("Remove").disabled).toBe(true);
  });

  it("leaves a later dialog open when an earlier answer comes late", async () => {
    await show(admin);
    await choose("Office: more", "Rename");
    await type(dialog()!.querySelector("input")!, "Study");
    let answer!: (room: typeof office) => void;
    vi.mocked(coreJson).mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve as typeof answer)),
    );
    await act(async () => button("Save").click());
    await act(async () => button("Cancel").click());
    await choose("Kitchen: more", "Rename");

    places = { ...places, rooms: [kitchen, { ...office, name: "Study" }] };
    await act(async () => answer({ ...office, name: "Study" }));

    expect(dialog()!.querySelector("input")!.value).toBe("Kitchen");
    expect(button("Save").disabled).toBe(false);
    expect(section().textContent).toContain("Study");
  });

  it("keeps a newer change from another client over its own late answer", async () => {
    await show(admin);
    await choose("Office: more", "Rename");
    await type(dialog()!.querySelector("input")!, "Study");
    let answer!: (room: typeof office) => void;
    vi.mocked(coreJson).mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve as typeof answer)),
    );
    await act(async () => button("Save").click());

    // Someone else renamed it again, and the live socket said so first.
    places = { ...places, rooms: [{ ...office, name: "Den" }, kitchen] };
    await act(async () => live.publish({ type: "places", places }));
    await act(async () => answer({ ...office, name: "Study" }));

    expect(section().textContent).toContain("Den");
    expect(section().textContent).not.toContain("Study");
  });
});

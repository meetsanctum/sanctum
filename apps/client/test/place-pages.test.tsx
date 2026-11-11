// @vitest-environment jsdom
import type {
  AppInfo,
  DeviceInfo,
  EntityInfo,
  Places,
  RoomSectionInfo,
} from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import {
  CategoryPage,
  HomeStatus,
  RoomPage,
  SidebarPlaces,
} from "../src/place-pages";
import { useSectionEntities } from "../src/room-sections";
import { useDevices } from "../src/use-devices";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

// Room and category pages, the shell's: a button for all the lights, the
// devices by category or room, and apps' room sections drawn from their
// entities.

const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  zones: [],
  rooms: [
    { id: "office", name: "Office", floorId: null },
    { id: "hall", name: "Hall", floorId: null },
    { id: "attic", name: "Attic", floorId: null },
  ],
};

function light(
  id: string,
  name: string,
  roomId: string | null,
  on: boolean,
): DeviceInfo {
  const state = { on, brightness: 40 };
  return {
    id,
    name,
    driverName: name,
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
    capabilities: [
      {
        id: "light",
        kind: "light",
        features: { brightness: true, colorTemperature: null, color: false },
        state,
        observed: state,
        desired: null,
        sync: "synced",
        setBy: null,
        changedAt: null,
      },
    ],
  };
}
const plug: DeviceInfo = {
  ...light("plug", "Kettle", "office", true),
  capabilities: [
    {
      id: "power",
      kind: "switch",
      features: {},
      state: { on: true },
      observed: { on: true },
      desired: null,
      sync: "synced",
      setBy: null,
      changedAt: null,
    },
  ],
};
const lamp = light("lamp", "Lamp", "office", true);
const hallLight = light("hall-light", "Ceiling", "hall", false);
const loose = light("loose", "Loose", null, false);

const moodsSection: RoomSectionInfo = {
  id: "moods.room",
  title: "Moods",
  entityType: "moods.mood",
  kind: "tiles",
  order: 200,
  press: { action: "moods.runMood" },
  open: { page: "room", label: "Edit" },
  whenEmpty: { roomHas: "light" },
};
const app = (id: string, name: string, section: RoomSectionInfo): AppInfo => ({
  id,
  name,
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
    roomSections: [section],
    devicePages: [],
  },
});
const moods = app("sanctum.moods", "Moods", moodsSection);
// More apps' sections, which come after Moods by their weight, ties by
// app id, and before the devices.
const spots = app("test.spots", "Spots", {
  ...moodsSection,
  id: "spots.room",
  title: "Spots",
  entityType: "spots.spot",
  order: 400,
  press: { action: "spots.use" },
  open: null,
  whenEmpty: null,
});
const alarms = app("test.alarms", "Alarms", {
  ...spots.provides.roomSections[0]!,
  id: "alarms.room",
  title: "Alarms",
  entityType: "alarms.alarm",
  order: 500,
  press: { action: "alarms.arm" },
});
const awnings = app("test.awnings", "Awnings", {
  ...alarms.provides.roomSections[0]!,
  id: "awnings.room",
  title: "Awnings",
  entityType: "awnings.awning",
});

const entity = (
  appId: string,
  type: string,
  key: string,
  state: Record<string, unknown>,
): EntityInfo => ({
  app: appId,
  key,
  type,
  name: String(state.name),
  state: { icon: "sun", order: 0, active: false, input: { id: key }, ...state },
  updatedAt: "2026-10-29T10:00:00.000Z",
});
const relax = entity("sanctum.moods", "moods.mood", "relax", {
  placeId: "office",
  name: "Relax",
  icon: "armchair",
  order: 0,
  active: true,
});
const work = entity("sanctum.moods", "moods.mood", "work", {
  placeId: "office",
  name: "Work",
  icon: "briefcase",
  order: 1,
});

let root: Root;
let container: HTMLDivElement;
let live: ReturnType<typeof createLiveFeed>;
let devices: DeviceInfo[];
let entities: EntityInfo[];
let answers: Record<string, () => Promise<unknown>>;
const openApp = vi.fn();
const openDevice = vi.fn();
const back = vi.fn();

function Harness(props: {
  page: "room" | "category";
  id: string;
  apps: AppInfo[];
}) {
  const shown = useDevices(live);
  const sectionEntities = useSectionEntities(live, props.apps, shown.fail);
  return props.page === "room" ? (
    <RoomPage
      roomId={props.id}
      devices={shown}
      apps={props.apps}
      entities={sectionEntities}
      openApp={openApp}
      canOpen={() => true}
      openDevice={openDevice}
      back={back}
    />
  ) : (
    <>
      <CategoryPage
        kind={props.id}
        devices={shown}
        openDevice={openDevice}
        back={back}
      />
      <nav>
        <SidebarPlaces
          devices={shown}
          current={{ page: "category", params: { kind: props.id } }}
          open={() => {}}
        />
      </nav>
    </>
  );
}

async function show(
  page: "room" | "category",
  id: string,
  apps: AppInfo[] = [moods],
) {
  await act(async () => {
    root.render(<Harness page={page} id={id} apps={apps} />);
  });
  await act(async () => {
    live.refresh();
  });
}

const button = (text: string) =>
  [...container.querySelectorAll("main button, button")].find(
    (each) =>
      each.textContent === text || each.getAttribute("aria-label") === text,
  ) as HTMLButtonElement | undefined;
// A tile, by the name it starts with.
const tile = (name: string) =>
  [...container.querySelectorAll("button")].find((each) =>
    each.textContent?.startsWith(name),
  ) as HTMLButtonElement | undefined;
const headings = () =>
  [...container.querySelectorAll("main h2, h2")].map(
    (each) => each.textContent,
  );
const posted = (path: string) =>
  vi
    .mocked(coreJson)
    .mock.calls.filter(([each]) => each === path)
    .map(([, init]) => init?.json);

async function click(element: HTMLElement | undefined) {
  if (!element) throw new Error("Nothing to click");
  await act(async () => {
    element.click();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  live = createLiveFeed();
  devices = [lamp, plug, hallLight, loose];
  entities = [relax, work];
  answers = {};
  openApp.mockReset();
  back.mockReset();
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (answers[path]) return answers[path]();
    if (path === "/api/devices") return devices;
    if (path === "/api/places") return places;
    if (path.startsWith("/api/entities?")) {
      const query = new URLSearchParams(path.split("?")[1]);
      return entities.filter(
        (each) =>
          each.app === query.get("app") && each.type === query.get("type"),
      );
    }
    if (path === "/api/devices/lights") {
      return { on: false, switched: 1, failed: [] };
    }
    return { switched: 1, failed: [] };
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

describe("all the lights", () => {
  it("does not describe remote presses as on or off in the Buttons header", async () => {
    devices = [
      {
        ...lamp,
        id: "remote",
        name: "Remote",
        capabilities: [
          {
            id: "button",
            kind: "button",
            features: { actions: ["single"], holds: [] },
            state: null,
            observed: null,
            desired: null,
            sync: "synced",
            setBy: null,
            changedAt: null,
          },
        ],
      },
    ];
    await show("category", "button");
    expect(container.querySelector("header")?.textContent).toBe("Buttons");
    await act(async () => {
      live.publish({
        type: "press",
        device: "remote",
        capability: "button",
        action: "single",
        at: new Date().toISOString(),
        isCaptured: false,
      });
    });
    expect(container.querySelector("header")?.textContent).toBe("Buttons");
  });

  it("of a room, from its page, through the core", async () => {
    await show("room", "office");
    const all = button("Turn off the Office lights")!;
    expect(all.textContent).toBe("1 Light on");
    await click(all);
    expect(posted("/api/devices/lights")).toEqual([
      { place: { kind: "room", id: "office" }, to: "toggle" },
    ]);
  });

  it("of the home, from Lights' page", async () => {
    await show("category", "light");
    await click(button("Turn off all the lights"));
    expect(posted("/api/devices/lights")).toEqual([
      { place: { kind: "home" }, to: "toggle" },
    ]);
  });

  it("cannot be switched while they are all offline", async () => {
    devices = [{ ...lamp, availability: "offline" }];
    await show("room", "office");
    const all = button("Turn on the Office lights")!;
    expect(all.textContent).toBe("Lights off");
    expect(all.disabled).toBe(true);
  });
});

describe("a category's page", () => {
  it("shows its tiles by room, devices with no room last, and the sidebar marks it", async () => {
    await show("category", "light");
    expect(container.querySelector("h1")?.textContent).toBe("Lights");
    expect(headings()).toEqual([
      "Office",
      "Hall",
      "Not in a room",
      "Categories",
      "Rooms",
    ]);
    const current = container.querySelector("nav [aria-current=page]");
    expect(current?.textContent).toBe("Lights1 on");
    expect(
      [...container.querySelectorAll("nav button")].map(
        (each) => each.textContent,
      ),
    ).toEqual(["Lights1 on", "Switches", "Office", "Hall", "Attic"]);
  });

  it("is not in the sidebar while the home has none of its devices", async () => {
    devices = [lamp];
    await show("category", "light");
    expect(
      [...container.querySelectorAll("nav button")].map(
        (each) => each.textContent,
      ),
    ).toEqual(["Lights1 on", "Office", "Hall", "Attic"]);
  });
});

describe("a room's page", () => {
  it("has Moods first, then other apps' sections by weight and app id, then its devices by category", async () => {
    entities = [
      relax,
      entity("test.spots", "spots.spot", "desk", {
        placeId: "office",
        name: "Desk",
      }),
      entity("test.alarms", "alarms.alarm", "door", {
        placeId: "office",
        name: "Door",
      }),
      entity("test.awnings", "awnings.awning", "south", {
        placeId: "office",
        name: "South",
      }),
    ];
    await show("room", "office", [awnings, spots, moods, alarms]);
    expect(headings()).toEqual([
      "Moods",
      "Spots",
      "Alarms",
      "Awnings",
      "Lights",
      "Switches",
    ]);
  });

  it("heads apps' sections like its own, with no app colour or icon", async () => {
    await show("room", "office");
    const heading = (text: string) =>
      [...container.querySelectorAll("h2")].find(
        (each) => each.textContent === text,
      )!;
    // The same element but for its id and words: no colour, no icon.
    const looks = (element: Element) =>
      element.outerHTML
        .replace(/ id="[^"]*"/, "")
        .replace(element.textContent!, "");
    expect(looks(heading("Moods"))).toBe(looks(heading("Lights")));
    expect(heading("Moods").children).toHaveLength(0);
  });

  it("shows a room's moods in their order, the active one pressed, and runs one on a tap", async () => {
    await show("room", "office");
    const names = [...container.querySelectorAll("section")]
      .find((each) => each.querySelector("h2")?.textContent === "Moods")!
      .querySelectorAll("button[aria-pressed]");
    expect([...names].map((each) => each.textContent)).toEqual([
      "Relax",
      "Work",
    ]);
    expect(tile("Relax")?.getAttribute("aria-pressed")).toBe("true");
    expect(tile("Work")?.getAttribute("aria-pressed")).toBe("false");

    await click(tile("Work"));
    expect(posted("/api/apps/sanctum.moods/actions/moods.runMood")).toEqual([
      { id: "work" },
    ]);
  });

  it("follows the app's entities live, in the room only", async () => {
    await show("room", "office");
    await act(async () => {
      live.publish({
        type: "entity",
        app: "sanctum.moods",
        key: "work",
        entity: {
          ...work,
          state: { ...(work.state as object), active: true, order: 0 },
        },
        was: "moods.mood",
      });
      live.publish({
        type: "entity",
        app: "sanctum.moods",
        key: "relax",
        entity: null,
        was: "moods.mood",
      });
      live.publish({
        type: "entity",
        app: "sanctum.moods",
        key: "bright",
        entity: entity("sanctum.moods", "moods.mood", "bright", {
          placeId: "hall",
          name: "Bright",
        }),
        was: null,
      });
    });
    expect(tile("Relax")).toBeUndefined();
    expect(tile("Bright")).toBeUndefined();
    expect(tile("Work")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("opens the app's page for the room from Edit", async () => {
    await show("room", "office");
    await click(button("Edit"));
    expect(openApp).toHaveBeenCalledWith("sanctum.moods", "room", {
      placeId: "office",
    });
    expect(tile("Relax")?.disabled).toBe(false);
  });

  it("keeps Moods' heading and Edit in a room with lights but no moods", async () => {
    entities = [];
    await show("room", "hall");
    expect(headings()).toEqual(["Moods", "Lights"]);
    expect(button("Edit")).toBeDefined();
  });

  it("has no Moods in a room without lights or moods", async () => {
    await show("room", "attic");
    expect(headings()).toEqual([]);
  });

  it("shows a failed tap on the tile, and the lights a run could not set on theirs", async () => {
    const animate = vi.fn();
    Element.prototype.animate = animate;
    try {
      await show("room", "office");
      answers["/api/apps/sanctum.moods/actions/moods.runMood"] = async () => ({
        switched: 0,
        failed: [{ device: "lamp", capability: "light" }],
      });
      await click(tile("Work"));
      const failed = () =>
        (
          animate.mock.contexts.filter(
            (element) => element instanceof HTMLButtonElement,
          ) as HTMLButtonElement[]
        ).map((each) => each.textContent?.slice(0, 4));
      expect(failed()).toEqual(["Lamp"]);

      answers["/api/apps/sanctum.moods/actions/moods.runMood"] = async () => {
        throw new Error("unavailable");
      };
      await click(tile("Relax"));
      expect(failed()).toEqual(["Lamp", "Rela"]);
    } finally {
      delete (Element.prototype as Partial<Element>).animate;
    }
  });

  it("leaves when the room goes", async () => {
    await show("room", "office");
    await act(async () => {
      live.publish({
        type: "places",
        places: { ...places, rooms: places.rooms.slice(1) },
      });
    });
    expect(back).toHaveBeenCalledTimes(1);
  });
});

// A climate sensor in a room, as Zigbee brings one: a reading for each
// measure.
function sensor(
  id: string,
  roomId: string | null,
  temperature: number,
  humidity: number,
  availability: DeviceInfo["availability"] = "online",
): DeviceInfo {
  const reading = (measure: "temperature" | "humidity", value: number) => ({
    id: measure,
    kind: "sensor" as const,
    features: { measures: measure },
    state: { value },
    observed: { value },
    desired: null,
    sync: "synced" as const,
    setBy: null,
    changedAt: null,
  });
  return {
    ...light(id, `${id} sensor`, roomId, false),
    availability,
    battery: 87,
    capabilities: [
      reading("temperature", temperature),
      reading("humidity", humidity),
    ],
  };
}

describe("the climate", () => {
  const readingsLine = () =>
    container.querySelector(
      "header [data-slot=readings]",
    ) as HTMLElement | null;

  it("of a room is under its name: each measure, ranged across its sensors, offline ones left out", async () => {
    devices = [
      lamp,
      sensor("desk", "office", 19.5, 58),
      sensor("window", "office", 20.24, 55.4),
      sensor("door", "office", 12, 90, "offline"),
    ];
    await show("room", "office");

    // Each measure is named for screen readers, as its icon shows it.
    expect(readingsLine()?.textContent).toBe(
      "Temperature 19.5–20.2°Humidity 55–58%",
    );
    expect(headings()).toEqual(["Moods", "Lights", "Climate"]);
  });

  it("is not on the page of a room without sensors", async () => {
    await show("room", "office");
    expect(readingsLine()).toBeNull();
  });

  it("of the home heads Climate's page, which the sidebar lists before Buttons", async () => {
    devices = [
      lamp,
      plug,
      sensor("desk", "office", 21.5, 48),
      sensor("hall", "hall", 19.5, 58),
    ];
    await show("category", "sensor");

    expect(container.querySelector("h1")?.textContent).toBe("Climate");
    expect(container.querySelector("header p")?.textContent).toBe(
      "19.5–21.5° · 48–58%",
    );
    expect(
      [...container.querySelectorAll("nav button")].map(
        (each) => each.textContent,
      ),
    ).toEqual(["Lights1 on", "Switches", "Climate", "Office", "Hall", "Attic"]);
  });
});

describe("the home's status", () => {
  const openCategory = vi.fn();
  const openAttention = vi.fn();
  const openMaintenance = vi.fn();

  function Status() {
    const shown = useDevices(live);
    return (
      <HomeStatus
        devices={shown}
        apps={[]}
        openCategory={openCategory}
        openAttention={openAttention}
        openMaintenance={openMaintenance}
      />
    );
  }

  async function showStatus() {
    await act(async () => {
      root.render(<Status />);
    });
    await act(async () => {
      live.refresh();
    });
  }

  const tiles = () => [
    ...container.querySelectorAll("section[aria-label='Home status'] button"),
  ];

  it("says what the sensors read and how many lights and switches are on, each opening its category", async () => {
    openCategory.mockReset();
    devices = [
      lamp,
      hallLight,
      plug,
      sensor("desk", "office", 21.5, 48),
      sensor("hall", "hall", 19.5, 58),
    ];
    await showStatus();

    expect(tiles().map((each) => each.textContent)).toEqual([
      "Climate19.5–21.5°",
      "Lights1 on",
      "Switches1 on",
    ]);
    expect(tiles()[0]?.getAttribute("aria-label")).toBe(
      "Climate, 19.5 to 21.5°",
    );
    await click(tiles()[0] as HTMLElement);
    expect(openCategory).toHaveBeenCalledWith("sensor");
  });

  it("ends with Batteries while a battery is to replace, which opens Maintenance", async () => {
    openMaintenance.mockReset();
    devices = [
      lamp,
      { ...sensor("hall", "hall", 19.5, 58), battery: 8 },
      { ...sensor("desk", "office", 21.5, 48), battery: 4 },
    ];
    await showStatus();

    expect(tiles().map((each) => each.textContent)).toEqual([
      "Climate19.5–21.5°",
      "Lights1 on",
      "BatteriesReplace 2",
    ]);
    expect(tiles().at(-1)?.getAttribute("aria-label")).toBe(
      "Batteries, replace 2: desk sensor's battery is at 4%, hall sensor's battery is at 8%. Opens Maintenance",
    );
    await click(tiles().at(-1) as HTMLElement);
    expect(openMaintenance).toHaveBeenCalledOnce();

    // One battery says its device; at 10% or more, none does.
    devices = [lamp, { ...sensor("hall", "hall", 19.5, 58), battery: 8 }];
    await showStatus();
    expect(tiles().at(-1)?.textContent).toBe("hall sensorBattery 8%");
    devices = [lamp, { ...sensor("hall", "hall", 19.5, 58), battery: 10 }];
    await showStatus();
    expect(tiles().map((each) => each.textContent)).toEqual([
      "Climate19.5°",
      "Lights1 on",
    ]);
  });

  it("has only the categories the home has, and says when no sensor reads anything", async () => {
    devices = [lamp, sensor("hall", "hall", 19.5, 58, "offline")];
    await showStatus();

    expect(tiles().map((each) => each.textContent)).toEqual([
      "ClimateNo readings",
      "Lights1 on",
      // The sensor that doesn't answer needs attention.
      "hall sensorOffline",
    ]);
  });

  it("ends with what needs attention, by name for one device, opening Settings", async () => {
    openAttention.mockReset();
    devices = [lamp, { ...hallLight, availability: "offline" }];
    await showStatus();

    const attention = tiles().at(-1)!;
    expect(attention.textContent).toBe("CeilingOffline");
    expect(attention.getAttribute("aria-label")).toBe("Ceiling is offline");
    // A problem's sign is red.
    expect(attention.querySelector("svg")?.getAttribute("style")).toContain(
      "var(--danger)",
    );
    await click(attention as HTMLElement);
    expect(openAttention).toHaveBeenCalledOnce();
  });

  it("counts several devices, the most pressing first, and is Graphite while there are only rooms to choose", async () => {
    devices = [
      lamp,
      {
        ...light("gone", "Hall plug", "hall", false),
        leftAt: "2026-10-31T12:00:00.000Z",
      },
      { ...lamp, id: "dark", name: "Desk lamp", availability: "offline" },
    ];
    await showStatus();
    expect(tiles().at(-1)?.textContent).toBe("Attention2 devices");
    expect(tiles().at(-1)?.getAttribute("aria-label")).toBe(
      "Attention, 2 devices: Hall plug isn't paired any more, Desk lamp is offline",
    );

    devices = [lamp, loose];
    await showStatus();
    expect(tiles().at(-1)?.textContent).toBe("LooseNo room");
    expect(
      tiles().at(-1)?.querySelector("svg")?.getAttribute("style"),
    ).toContain("var(--graphite-text)");
  });

  it("has no Attention while every device is fine, a low battery being Maintenance's", async () => {
    devices = [
      lamp,
      hallLight,
      { ...sensor("hall", "hall", 19.5, 58), battery: 8 },
    ];
    await showStatus();
    expect(tiles().map((each) => each.textContent)).toEqual([
      "Climate19.5°",
      "Lights1 on",
      "hall sensorBattery 8%",
    ]);
  });

  it("ends with Attention, then Batteries", async () => {
    devices = [
      lamp,
      { ...sensor("hall", "hall", 19.5, 58), battery: 8 },
      { ...hallLight, availability: "offline" },
    ];
    await showStatus();
    expect(
      tiles()
        .map((each) => each.textContent)
        .slice(-2),
    ).toEqual(["CeilingOffline", "hall sensorBattery 8%"]);
  });

  it("removes stale readings and shows Batteries when a quiet day passes without a live event", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    try {
      vi.setSystemTime(new Date("2026-10-31T11:59:00Z"));
      devices = [
        {
          ...sensor("hall", "hall", 19.5, 58),
          availability: "unknown",
          battery: 64,
          lastSeenAt: "2026-10-30T12:00:00Z",
        },
      ];
      await showStatus();
      expect(tiles().map((each) => each.textContent)).toEqual(["Climate19.5°"]);
      await act(async () => {
        vi.advanceTimersByTime(60_000);
      });
      expect(tiles().map((each) => each.textContent)).toEqual([
        "ClimateNo readings",
        "hall sensorGone quiet",
      ]);
    } finally {
      await act(async () => root.render(null));
      vi.useRealTimers();
    }
  });
});

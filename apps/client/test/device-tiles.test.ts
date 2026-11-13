import type {
  CapabilityInfo,
  DeviceInfo,
  LightState,
  Places,
  SyncStatus,
} from "@meetsanctum/app-sdk";
import { deviceTypeOf } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import {
  climateMeasures,
  readingsOf,
  readingsText,
  sectionsByCategory,
  sectionsByRoom,
  sensorReadings,
  tilesOf,
} from "../src/device-tiles";

const roomSections = (devices: DeviceInfo[], home: Places) =>
  sectionsByRoom(tilesOf(devices, home), home);

const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  rooms: [
    { id: "living", name: "Living room", floorId: null },
    { id: "kitchen", name: "Kitchen", floorId: null },
  ],
  zones: [],
};

function light(
  state: LightState | null,
  sync: SyncStatus = "synced",
): CapabilityInfo {
  return {
    id: "light",
    kind: "light",
    features: { brightness: true, colorTemperature: null, color: false },
    state,
    observed: state,
    desired: null,
    sync,
    setBy: null,
    changedAt: null,
  };
}

function plug(id: string, on: boolean): CapabilityInfo {
  const state = { on };
  return {
    id,
    kind: "switch",
    features: {},
    state,
    observed: state,
    desired: null,
    sync: "synced",
    setBy: null,
    changedAt: null,
  };
}

function device(
  id: string,
  name: string,
  roomId: string | null,
  capabilities: CapabilityInfo[],
  availability: DeviceInfo["availability"] = "online",
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
    availability,
    lastSeenAt: null,
    firmware: null,
    probe: false,
    battery: null,
    leftAt: null,
    capabilities,
  };
}

describe("sectionsByRoom", () => {
  it("puts tiles in their rooms' order, sorted by name, with devices without a room last", () => {
    const sections = roomSections(
      [
        device("a", "Pantry", null, [light({ on: false })]),
        device("b", "Kettle", "kitchen", [plug("switch", false)]),
        device("c", "Floor lamp", "living", [light({ on: false })]),
        device("d", "Ceiling light", "living", [light({ on: false })]),
        device("e", "Lamp", "attic", [light({ on: false })]),
      ],
      places,
    );
    expect(
      sections.map((section) => [
        section.title,
        section.tiles.map((tile) => tile.name),
      ]),
    ).toEqual([
      ["Living room", ["Ceiling light", "Floor lamp"]],
      ["Kitchen", ["Kettle"]],
      ["Not in a room", ["Lamp", "Pantry"]],
    ]);
  });

  it("names each switch of a device that has several", () => {
    const [section] = roomSections(
      [
        device("a", "Hall switch", "living", [
          plug("l1", true),
          plug("l2", false),
        ]),
      ],
      places,
    );
    expect(section!.tiles.map((tile) => [tile.name, tile.look])).toEqual([
      ["Hall switch l1", "on"],
      ["Hall switch l2", "off"],
    ]);
  });

  it("shows a lit light in its colour with its brightness", () => {
    const [section] = roomSections(
      [
        device("a", "Ceiling light", "living", [
          light({ on: true, brightness: 80 }),
        ]),
      ],
      places,
    );
    expect(section!.tiles[0]).toMatchObject({
      status: "80%",
      on: true,
      look: "lit",
      colour: "#ffcfa3",
    });
  });

  it("says when a device is offline, unknown or not responding", () => {
    const [section] = roomSections(
      [
        device("a", "Away", "living", [light({ on: true })], "offline"),
        device("b", "New", "living", [light(null)]),
        device("c", "Stuck", "living", [light({ on: true }, "conflict")]),
      ],
      places,
    );
    expect(
      section!.tiles.map((tile) => [tile.name, tile.status, tile.disabled]),
    ).toEqual([
      ["Away", "Offline", true],
      ["New", "Unknown", false],
      ["Stuck", "Not responding", false],
    ]);
  });

  it("says what a command still on its way asks for, and what waits for a light to turn on", () => {
    const waiting = (
      observed: LightState,
      desired: Partial<LightState>,
      sync: SyncStatus,
    ): CapabilityInfo =>
      ({
        ...light({ ...observed, ...desired }, sync),
        observed,
        desired,
      }) as CapabilityInfo;
    const [section] = roomSections(
      [
        device("a", "A", "living", [
          waiting({ on: false, brightness: 60 }, { on: true }, "pending"),
        ]),
        device("b", "B", "living", [
          waiting({ on: true, brightness: 60 }, { on: false }, "pending"),
        ]),
        device("c", "C", "living", [
          waiting({ on: true, brightness: 60 }, { brightness: 40 }, "pending"),
        ]),
        device("d", "D", "living", [
          waiting({ on: false, brightness: 60 }, { brightness: 40 }, "held"),
        ]),
        device("e", "E", "living", [
          waiting(
            { on: false, brightness: 60 },
            { colorMode: "color", hue: 120, saturation: 80 },
            "held",
          ),
        ]),
      ],
      places,
    );
    expect(section!.tiles.map((tile) => [tile.name, tile.status])).toEqual([
      ["A", "Turning on…"],
      ["B", "Turning off…"],
      ["C", "40%"],
      ["D", "Off · 40% when on"],
      ["E", "Off · new colour when on"],
    ]);
  });

  it("lets a light that reports its brightness dim, and nothing else", () => {
    const fixed: CapabilityInfo = {
      id: "light",
      kind: "light",
      features: { brightness: false, colorTemperature: null, color: false },
      state: { on: true },
      observed: { on: true },
      desired: null,
      sync: "synced",
      setBy: null,
      changedAt: null,
    };
    const [section] = roomSections(
      [
        device("a", "Dims", "living", [light({ on: false, brightness: 30 })]),
        device("b", "Fixed", "living", [fixed]),
        device("c", "Plug", "living", [plug("switch", true)]),
      ],
      places,
    );
    expect(
      section!.tiles.map((tile) => [tile.name, tile.dims, tile.status]),
    ).toEqual([
      ["Dims", true, "Off"],
      ["Fixed", false, "On"],
      ["Plug", false, "On"],
    ]);
  });
});

// A remote with a button and nothing to switch.
function remote(id: string, name: string, roomId: string | null) {
  return device(id, name, roomId, [
    {
      id: "button",
      kind: "button",
      features: { actions: ["single", "double", "hold"], holds: [] },
      state: null,
      observed: null,
      desired: null,
      sync: "synced",
      setBy: null,
      changedAt: null,
    },
  ]);
}

describe("a remote's tile", () => {
  it("is idle, and shows a press while it lasts, White like a switch that is on", () => {
    const devices = [remote("button", "Office button", "living")];

    expect(tilesOf(devices, places)).toEqual([
      expect.objectContaining({
        key: "button/button",
        kind: "button",
        status: "Idle",
        look: "off",
        on: false,
        dims: false,
      }),
    ]);
    expect(
      tilesOf(devices, places, new Map([["button/button", "double"]])),
    ).toEqual([
      expect.objectContaining({ status: "Double press", look: "on" }),
    ]);
    expect(
      tilesOf(
        [
          device(
            "b",
            "Away",
            null,
            remote("x", "", null).capabilities,
            "offline",
          ),
        ],
        places,
      ),
    ).toEqual([expect.objectContaining({ status: "Offline", disabled: true })]);
  });

  it("says not paired for one its network no longer has", () => {
    const [left] = [
      {
        ...device(
          "b",
          "Away",
          null,
          remote("x", "", null).capabilities,
          "offline",
        ),
        leftAt: "2026-10-31T12:00:00.000Z",
      },
    ];
    expect(tilesOf([left!], places)).toEqual([
      expect.objectContaining({ status: "Not paired", disabled: true }),
    ]);
  });
});

describe("a device with several buttons", () => {
  it("has a tile for each, named by its button", () => {
    const [left, right] = ["left", "right"].map((id) => ({
      ...remote("x", "", null).capabilities[0]!,
      id,
    }));
    expect(
      tilesOf(
        [device("wall", "Hall switch", "living", [left!, right!])],
        places,
        new Map([["wall/right", "single"]]),
      ).map((tile) => [tile.key, tile.name, tile.status]),
    ).toEqual([
      ["wall/left", "Hall switch left", "Idle"],
      ["wall/right", "Hall switch right", "Single press"],
    ]);
  });
});

describe("sectionsByCategory", () => {
  it("groups a room's tiles by category, lights first", () => {
    const tiles = tilesOf(
      [
        device("a", "TV plug", "living", [plug("switch", true)]),
        device("b", "Floor lamp", "living", [light({ on: false })]),
        device("c", "Kettle", "kitchen", [plug("switch", false)]),
        remote("d", "Living room button", "living"),
      ],
      places,
    ).filter((tile) => tile.roomId === "living");
    expect(
      sectionsByCategory(tiles).map((section) => [
        section.title,
        section.tiles.map((tile) => tile.name),
      ]),
    ).toEqual([
      ["Lights", ["Floor lamp"]],
      ["Switches", ["TV plug"]],
      ["Buttons", ["Living room button"]],
    ]);
  });
});

function reading(
  measure: "temperature" | "humidity" | "illuminance",
  value: number | null,
): CapabilityInfo {
  const state = value === null ? null : { value };
  return {
    id: measure,
    kind: "sensor",
    features: { measures: measure },
    state,
    observed: state,
    desired: null,
    sync: "synced",
    setBy: null,
    changedAt: null,
  };
}

const climate = (
  id: string,
  roomId: string | null,
  temperature: number | null,
  humidity: number | null,
  availability: DeviceInfo["availability"] = "online",
) =>
  device(
    id,
    `${id} sensor`,
    roomId,
    [reading("temperature", temperature), reading("humidity", humidity)],
    availability,
  );

describe("a sensor's tile", () => {
  it("is one for its device, with what it reads now", () => {
    const tiles = tilesOf([climate("office", "living", 21.47, 48.4)], places);

    expect(tiles).toEqual([
      expect.objectContaining({
        key: "office/temperature",
        kind: "sensor",
        name: "office sensor",
        status: "21.5° · 48%",
        readings: { temperature: 21.47, humidity: 48.4 },
        disabled: false,
      }),
    ]);
  });

  it("shows temperatures in the home's unit, and only what it reads", () => {
    const [tile] = tilesOf([climate("office", "living", 21.5, null)], {
      ...places,
      home: { ...places.home, temperatureUnit: "fahrenheit" },
    });

    expect(tile?.status).toBe("70.7°");
  });

  it("waits for its first reading, and says when it is offline", () => {
    const tiles = tilesOf(
      [
        climate("bedroom", "living", null, null),
        climate("hall", "living", 19, 50, "offline"),
      ],
      places,
    );

    expect(tiles.map((tile) => [tile.status, tile.disabled])).toEqual([
      ["Waiting for a reading", false],
      ["Offline", true],
    ]);
    expect(tiles[1]?.readings).toBeUndefined();
  });

  it("says a sensor and a remote on a battery gone quiet haven't been heard from, not what they read days ago", () => {
    const now = Date.parse("2026-10-31T12:00:00Z");
    const quiet = {
      availability: "unknown" as const,
      lastSeenAt: "2026-10-27T09:10:00Z",
      battery: 6,
    };
    const tiles = tilesOf(
      [
        { ...climate("hall", "living", 19, 50), ...quiet },
        { ...remote("button", "Office button", "living"), ...quiet },
      ],
      places,
      new Map(),
      now,
    );

    expect(tiles.map((tile) => [tile.name, tile.status])).toEqual([
      ["hall sensor", "Not heard from"],
      ["Office button", "Not heard from"],
    ]);
    expect(tiles[0]?.readings).toBeUndefined();
  });

  it("is in Environment, after switches and before buttons, on a room's page", () => {
    const sections = sectionsByCategory(
      tilesOf(
        [
          climate("office", "living", 21.5, 48),
          device("lamp", "Lamp", "living", [light({ on: false })]),
        ],
        places,
      ),
    );

    expect(sections.map((section) => section.title)).toEqual([
      "Lights",
      "Environment",
    ]);
  });
});

describe("what sensors read", () => {
  it("is each measure's value, or its lowest and highest across them", () => {
    expect(readingsText([{ temperature: 21.5, humidity: 48 }], "celsius")).toBe(
      "21.5° · 48%",
    );
    expect(
      readingsOf(
        [
          { temperature: 19.5, humidity: 58 },
          { temperature: 20.2, humidity: 55.4 },
        ],
        "celsius",
      ),
    ).toEqual([
      { measure: "temperature", text: "19.5–20.2°", spoken: "19.5 to 20.2°" },
      { measure: "humidity", text: "55–58%", spoken: "55 to 58%" },
    ]);
    expect(readingsText([], "celsius")).toBe("");
  });

  it("leaves out sensors that are offline or have read nothing yet", () => {
    const tiles = tilesOf(
      [
        climate("office", "living", 21.5, 48),
        climate("bedroom", "living", null, null),
        climate("hall", "living", 12, 80, "offline"),
      ],
      places,
    );

    expect(sensorReadings(tiles)).toEqual([
      { temperature: 21.5, humidity: 48 },
    ]);
  });
});

describe("light level", () => {
  it("joins a sensor's tile in lux, or is all it says", () => {
    const tiles = tilesOf(
      [
        device("office", "Office motion sensor", "living", [
          reading("temperature", 21),
          reading("illuminance", 318),
        ]),
        device("window", "Window sensor", "living", [
          reading("illuminance", 1_064),
        ]),
      ],
      places,
    );

    expect(tiles.map((tile) => tile.status)).toEqual([
      "21° · 320 lx",
      "1,100 lx",
    ]);
  });

  it("ranges across sensors last, and stays out of what Environment ranges", () => {
    const readings = [
      { temperature: 21, humidity: 48, illuminance: 320 },
      { temperature: 19.8, illuminance: 40.4 },
    ];
    expect(readingsOf(readings, "celsius").at(-1)).toEqual({
      measure: "illuminance",
      text: "40–320 lx",
      spoken: "40 to 320 lx",
    });
    expect(readingsText(readings, "celsius", climateMeasures)).toBe(
      "19.8–21° · 48%",
    );
  });
});

function occupancy(
  occupied: boolean | null,
  changedAt: string | null = null,
): CapabilityInfo {
  const state = occupied === null ? null : { occupied };
  return {
    id: "occupancy",
    kind: "occupancy",
    features: {
      senses: "motion",
      sensitivity: null,
      clearAfter: null,
      indicator: false,
    },
    state,
    observed: state,
    desired: null,
    sync: "synced",
    setBy: null,
    changedAt,
  };
}

describe("a motion sensor's tile", () => {
  const now = Date.parse("2026-10-31T12:00:00.000Z");
  const ago = (minutes: number) =>
    new Date(now - minutes * 60_000).toISOString();

  it("is White with Motion now while it sees motion, and says for how long it has seen none", () => {
    const tiles = tilesOf(
      [
        device("hall", "Hall motion sensor", "living", [
          occupancy(true, ago(1)),
        ]),
        device("stairs", "Stairs motion sensor", "living", [
          occupancy(false, ago(12)),
        ]),
      ],
      places,
      new Map(),
      now,
    );

    expect(
      tiles.map((tile) => [tile.kind, tile.status, tile.look, tile.on]),
    ).toEqual([
      ["occupancy", "Motion now", "on", true],
      ["occupancy", "Quiet for 12 min", "off", false],
    ]);
    expect(tiles[1]?.motion).toEqual({ occupied: false, changedAt: ago(12) });
  });

  it("waits for its first report, and says when it is offline", () => {
    const tiles = tilesOf(
      [
        device("hall", "Hall motion sensor", "living", [occupancy(null)]),
        device(
          "stairs",
          "Stairs motion sensor",
          "living",
          [occupancy(true, ago(1))],
          "offline",
        ),
      ],
      places,
    );

    expect(tiles.map((tile) => [tile.status, tile.disabled])).toEqual([
      ["Waiting for a reading", false],
      ["Offline", true],
    ]);
    expect(tiles.map((tile) => tile.motion)).toEqual([undefined, undefined]);
  });

  it("says one on a battery gone quiet hasn't been heard from, not how long it has seen no motion", () => {
    const [tile] = tilesOf(
      [
        {
          ...device("hall", "Hall motion sensor", "living", [
            occupancy(false, ago(4 * 24 * 60)),
          ]),
          availability: "unknown",
          lastSeenAt: ago(4 * 24 * 60),
          battery: 6,
        },
      ],
      places,
      new Map(),
      now,
    );

    expect([tile?.status, tile?.motion]).toEqual(["Not heard from", undefined]);
  });

  it("comes before its readings' tile, which keeps it under Environment too, and Presence follows Environment", () => {
    const tiles = tilesOf(
      [
        device("office", "Office motion sensor", "living", [
          occupancy(false, ago(3)),
          reading("temperature", 21),
          reading("illuminance", 320),
        ]),
        remote("button", "Living room button", "living"),
      ],
      places,
      new Map(),
      now,
    );

    expect(tiles.map((tile) => tile.key)).toEqual([
      "office/occupancy",
      "office/temperature",
      "button/button",
    ]);
    expect(
      sectionsByCategory(tiles).map((section) => [
        section.title,
        section.tiles.map((tile) => tile.status),
      ]),
    ).toEqual([
      ["Environment", ["21° · 320 lx"]],
      ["Presence", ["Quiet for 3 min"]],
      ["Buttons", ["Idle"]],
    ]);
  });
});

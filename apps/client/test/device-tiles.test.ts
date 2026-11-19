import type {
  CapabilityInfo,
  DeviceInfo,
  LightState,
  Places,
  SyncStatus,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import {
  climateMeasures,
  readingsOf,
  readingsText,
  sectionsByRoom,
  sectionsOfRoom,
  sensorReadings,
  tilesOf,
} from "../src/device-tiles";
import {
  climate,
  device,
  light,
  motionCapability,
  places,
  plug,
  reading,
  remote,
} from "./device-tiles-fixtures";

const roomSections = (devices: DeviceInfo[], home: Places) =>
  sectionsByRoom(tilesOf(devices, home), home);

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
      ["No room", ["Lamp", "Pantry"]],
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

  it("shows a command still on its way as it will be, and what waits for a light to turn on", () => {
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
      ["A", "60%"],
      ["B", "Off"],
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

describe("sectionsOfRoom", () => {
  it("groups a room's tiles by category, lights first", () => {
    const devices = [
      device("a", "TV plug", "living", [plug("switch", true)]),
      device("b", "Floor lamp", "living", [light({ on: false })]),
      device("c", "Kettle", "kitchen", [plug("switch", false)]),
      remote("d", "Living room button", "living"),
    ];
    const tiles = tilesOf(devices, places).filter(
      (tile) => tile.roomId === "living",
    );
    expect(
      sectionsOfRoom(tiles, devices).map((section) => [
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

describe("a device with nothing Sanctum can use", () => {
  const purifier = (
    roomId: string | null,
    availability: DeviceInfo["availability"] = "online",
  ): DeviceInfo => ({
    ...device("p", "Unknown device", roomId, [], availability),
    driverName: "STARKVIND air purifier",
  });

  it("has one tile of its own, which says what its driver calls it", () => {
    expect(tilesOf([purifier("living")], places)).toEqual([
      {
        key: "p/",
        deviceId: "p",
        capabilityId: "",
        kind: "unknown",
        roomId: "living",
        name: "Unknown device",
        status: "STARKVIND air purifier",
        look: "off",
        on: false,
        dims: false,
        disabled: false,
      },
    ]);
  });

  it("says when it is offline or not paired any more, like any tile", () => {
    const [offline] = tilesOf([purifier(null, "offline")], places);
    expect(offline).toMatchObject({ status: "Offline", disabled: true });
    const [left] = tilesOf(
      [{ ...purifier(null, "offline"), leftAt: "2026-10-31T12:00:00Z" }],
      places,
    );
    expect(left).toMatchObject({ status: "Not paired", disabled: true });
  });

  it("is last on its room's page, under no category", () => {
    const devices = [
      purifier("living"),
      device("b", "Floor lamp", "living", [light({ on: false })]),
      remote("d", "Living room button", "living"),
    ];
    const tiles = tilesOf(devices, places);
    const titles = (sections: { title: string; tiles: { name: string }[] }[]) =>
      sections.map((section) => [
        section.title,
        section.tiles.map((tile) => tile.name),
      ]);
    expect(titles(sectionsOfRoom(tiles, devices))).toEqual([
      ["Lights", ["Floor lamp"]],
      ["Buttons", ["Living room button"]],
      ["Unknown devices", ["Unknown device"]],
    ]);
    // A room with none has no such section.
    expect(
      sectionsOfRoom(
        tiles.filter((tile) => tile.kind !== "unknown"),
        devices,
      ),
    ).toHaveLength(2);
  });
});

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
    const devices = [
      climate("office", "living", 21.5, 48),
      device("lamp", "Lamp", "living", [light({ on: false })]),
    ];
    const sections = sectionsOfRoom(tilesOf(devices, places), devices);

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

describe("a motion sensor's tile", () => {
  const now = Date.parse("2026-10-31T12:00:00.000Z");
  const ago = (minutes: number) =>
    new Date(now - minutes * 60_000).toISOString();

  it("is White with Motion now while it sees motion, and says for how long it has seen none", () => {
    const tiles = tilesOf(
      [
        device("hall", "Hall motion sensor", "living", [
          motionCapability(true, ago(1)),
        ]),
        device("stairs", "Stairs motion sensor", "living", [
          motionCapability(false, ago(12)),
        ]),
      ],
      places,
      new Map(),
      now,
    );

    expect(
      tiles.map((tile) => [tile.kind, tile.status, tile.look, tile.on]),
    ).toEqual([
      ["motion", "Motion now", "on", true],
      ["motion", "Quiet for 12 min", "off", false],
    ]);
    expect(tiles[1]?.motion).toEqual({ motion: false, changedAt: ago(12) });
  });

  it("waits for its first report, and says when it is offline", () => {
    const tiles = tilesOf(
      [
        device("hall", "Hall motion sensor", "living", [
          motionCapability(null),
        ]),
        device(
          "stairs",
          "Stairs motion sensor",
          "living",
          [motionCapability(true, ago(1))],
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
            motionCapability(false, ago(4 * 24 * 60)),
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

  it("comes before its readings' tile, and on a room's page joins them under Presence, which follows Environment", () => {
    const devices = [
      device("office", "Office motion sensor", "living", [
        motionCapability(false, ago(3)),
        reading("temperature", 21),
        reading("illuminance", 320),
      ]),
      remote("button", "Living room button", "living"),
      climate("air", "living", 21.5, 48),
    ];
    const tiles = tilesOf(devices, places, new Map(), now);

    expect(tiles.map((tile) => tile.key)).toEqual([
      "office/occupancy",
      "office/temperature",
      "button/button",
      "air/temperature",
    ]);
    expect(
      sectionsOfRoom(tiles, devices).map((section) => [
        section.title,
        section.tiles.map((tile) => tile.status),
      ]),
    ).toEqual([
      ["Environment", ["21.5° · 48%"]],
      ["Presence", ["Quiet for 3 min"]],
      ["Buttons", ["Idle"]],
    ]);
  });
});

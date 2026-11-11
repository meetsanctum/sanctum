import type { DeviceInfo, Places } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { chosenLights, lightGroups, lightsOf } from "../../src/ui/press-lights";
import { device, lightCapability } from "../moods/home";

// The lights a press can be for, from v1's button binding light picker
// tests (targetKey and groupLightOptions, button-actions.test.ts).

const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  rooms: [
    { id: "kitchen", name: "Kitchen", floorId: null },
    { id: "office", name: "Office", floorId: null },
  ],
  zones: [{ id: "downstairs", name: "Downstairs", roomIds: ["kitchen"] }],
};

function named(
  id: string,
  name: string,
  roomId: string | null,
  options: { on?: boolean; dims?: boolean } = {},
): DeviceInfo {
  return {
    ...device(id, roomId, [
      lightCapability(
        { on: options.on ?? false, brightness: 60 },
        { features: { brightness: options.dims ?? true } },
      ),
    ]),
    name,
  };
}

const devices = [
  named("ceiling", "Ceiling", "office", { on: true }),
  named("desk", "Desk lamp", "office"),
  named("strip", "Strip", "office", { dims: false }),
  named("counter", "Counter", "kitchen"),
  named("loose", "Loose lamp", null),
  // A remote, which no press chooses.
  device("remote", "office", [
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
  ]),
];

describe("chosen lights", () => {
  it("are each kept once, in a stable order", () => {
    expect(
      chosenLights([
        { device: "light-b", capability: "light" },
        { device: "light-a", capability: "light" },
        { device: "light-b", capability: "light" },
      ]),
    ).toEqual([
      { device: "light-a", capability: "light" },
      { device: "light-b", capability: "light" },
    ]);
  });

  it("start from the lights of the place a press was for", () => {
    expect(
      lightsOf({ kind: "zone", id: "downstairs" }, devices, places),
    ).toEqual([{ device: "counter", capability: "light" }]);
    expect(lightsOf({ kind: "home" }, devices, places)).toHaveLength(5);
  });
});

describe("the lights to choose from", () => {
  it("are grouped by room, the remote's first, each by name, with how it is", () => {
    expect(
      lightGroups(devices, places, "office").map((group) => [
        group.name,
        group.lights.map((light) => [light.name, light.detail]),
      ]),
    ).toEqual([
      [
        "Office",
        [
          ["Ceiling", "On · 60%"],
          ["Desk lamp", "Off"],
          ["Strip", "Off · Can't dim"],
        ],
      ],
      ["Kitchen", [["Counter", "Off"]]],
      ["No room", [["Loose lamp", "Off"]]],
    ]);
  });

  it("leave out rooms with no lights", () => {
    expect(
      lightGroups(
        devices.filter((each) => each.roomId !== "kitchen"),
        places,
        null,
      ).map((group) => group.name),
    ).toEqual(["Office", "No room"]);
  });
});

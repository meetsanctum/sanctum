import type { CapabilityInfo, DeviceInfo } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { sectionsOfRoom, tilesOf } from "../src/device-tiles";
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

// A room's page: one tile for each device, saying its main state, in the
// section of its type's category.

const now = Date.parse("2026-10-31T12:00:00.000Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

const button = remote("x", "", null).capabilities[0]!;

function contact(open: boolean): CapabilityInfo {
  const state = { open };
  return {
    id: "contact",
    kind: "contact",
    features: {},
    state,
    observed: state,
    desired: null,
    sync: "synced",
    setBy: null,
    changedAt: ago(30),
  };
}

const sections = (
  devices: DeviceInfo[],
  pressed: ReadonlyMap<string, string> = new Map(),
) =>
  sectionsOfRoom(tilesOf(devices, places, pressed, now), devices).map(
    (section) => [
      section.title,
      section.tiles.map((tile) => [tile.key, tile.name, tile.status]),
    ],
  );

describe("a room's page", () => {
  it("shows a light with a button and a temperature sensor as one light, saying its brightness", () => {
    const panel = device("panel", "Desk panel", "living", [
      light({ on: true, brightness: 80 }),
      button,
      reading("temperature", 22),
    ]);

    expect(sections([panel])).toEqual([
      ["Lights", [["panel/light", "Desk panel", "80%"]]],
    ]);
  });

  it("goes on showing whether a light with a button is on while it is pressed, and flashes a remote's", () => {
    const panel = device("panel", "Desk panel", "living", [
      light({ on: false, brightness: 80 }),
      button,
    ]);
    const devices = [panel, remote("remote", "Wall button", "living")];
    const pressed = new Map([
      ["panel/button", "single"],
      ["remote/button", "single"],
    ]);
    const [lights, buttons] = sectionsOfRoom(
      tilesOf(devices, places, pressed, now),
      devices,
    );

    expect(lights?.tiles).toEqual([
      expect.objectContaining({ status: "Off", look: "off", on: false }),
    ]);
    expect(buttons?.tiles).toEqual([
      expect.objectContaining({ status: "Single press", look: "on" }),
    ]);
  });

  it("shows a motion sensor that measures once, under Presence, saying its motion", () => {
    const sensor = device("motion", "Office motion sensor", "living", [
      motionCapability(false, ago(5)),
      reading("illuminance", 320),
    ]);

    expect(sections([sensor])).toEqual([
      [
        "Presence",
        [["motion/occupancy", "Office motion sensor", "Quiet for 5 min"]],
      ],
    ]);
  });

  it("shows a contact sensor that measures under Security, by what it is shown as", () => {
    const door = {
      ...device("door", "Hallway door", "living", [
        contact(false),
        reading("temperature", 19),
      ]),
      type: "door" as const,
      shownAs: "door" as const,
    };

    expect(sections([door])).toEqual([
      ["Security", [["door/contact", "Hallway door", "Closed"]]],
    ]);
  });

  it("shows a sensor's readings, as today", () => {
    expect(sections([climate("air", "living", 21.5, 48)])).toEqual([
      ["Environment", [["air/temperature", "air sensor", "21.5° · 48%"]]],
    ]);
  });

  it("keeps a tile for each further switch, named by its switch", () => {
    const relay = device("relay", "Office relay", "living", [
      plug("1", true),
      plug("2", false),
    ]);

    expect(sections([relay])).toEqual([
      [
        "Switches",
        [
          ["relay/1", "Office relay 1", "On"],
          ["relay/2", "Office relay 2", "Off"],
        ],
      ],
    ]);
  });

  it("switches a sensor that also switches by its switch, and says its readings under Environment", () => {
    const sensor = {
      ...device("air", "Air sensor", "living", [
        plug("fan", true),
        reading("temperature", 21),
      ]),
      type: "sensor" as const,
    };
    const [environment] = sectionsOfRoom(tilesOf([sensor], places), [sensor]);

    expect(environment).toMatchObject({
      title: "Environment",
      tiles: [
        {
          key: "air/fan",
          kind: "switch",
          capabilityId: "fan",
          status: "21°",
          on: true,
        },
      ],
    });
  });

  it("switches a light whose first part is a switch by its light, keeping the switch's own tile", () => {
    const lamp = {
      ...device("lamp", "Desk lamp", "living", [
        plug("relay", false),
        light({ on: true, brightness: 40 }),
      ]),
      type: "light" as const,
    };

    expect(sections([lamp])).toEqual([
      ["Lights", [["lamp/light", "Desk lamp light", "40%"]]],
      ["Switches", [["lamp/relay", "Desk lamp relay", "Off"]]],
    ]);
  });

  it("joins a remote's buttons into one tile, by its own name, which flashes with a press of any", () => {
    const wall = device("wall", "Hall switch", "living", [
      { ...button, id: "left" },
      { ...button, id: "right" },
    ]);

    expect(sections([wall], new Map([["wall/right", "single"]]))).toEqual([
      ["Buttons", [["wall/left", "Hall switch", "Single press"]]],
    ]);
  });
});

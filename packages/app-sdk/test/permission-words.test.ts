import { describe, expect, it } from "vitest";

import { permissionIcons, permissionWords } from "../src/index.js";

// How Sanctum names each permission, the same for every app, before the
// app's own reason.

describe("a permission's words", () => {
  it.each([
    ["places.read", "See your rooms", "door-closed"],
    ["places.location", "Know where your home is", "map-pin"],
    ["people.read", "See who lives here", "users"],
    ["devices.control:light", "Control your lights", "lightbulb"],
    ["devices.read:switch", "See your switches", "toggle-right"],
    ["devices.read:button", "See your remotes' presses", "circle-dot"],
    ["devices.read:occupancy", "Know when there's motion", "activity"],
    ["devices.read:sensor", "See what your sensors read", "thermometer"],
    ["devices.register", "Bring devices into your home", "square-plus"],
    ["workflows.manage", "Keep its own automations", "workflow"],
    ["net:api.open-meteo.com", "Reach api.open-meteo.com", "globe"],
    ["entities.read:weather.forecast", "Read the forecast", "share-2"],
  ])("names %s “%s”", (id, title, icon) => {
    expect(permissionWords(id)).toEqual({ title, detail: null, icon });
  });

  it("says who may hold a service", () => {
    expect(permissionWords("services:zigbee2mqtt")).toEqual({
      title: "Use Zigbee2MQTT",
      detail: "Only Sanctum's own apps",
      icon: "radio-tower",
    });
    expect(permissionWords("services:redis").title).toBe("Use redis");
  });

  it("keeps the id of one it doesn't know", () => {
    for (const id of [
      "camera",
      "devices.read:toaster",
      "net:",
      "entities.read:example.list",
    ]) {
      const words = permissionWords(id);
      expect(permissionIcons).toContain(words.icon);
      expect(words.title).toContain(id.split(":").at(-1) || id);
    }
  });
});

// @vitest-environment jsdom
import type { DeviceInfo, Places } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { stillThere, type PressPlace } from "../../src/presses/presses";
import { lightsOf } from "../../src/ui/press-lights";
import { placeLabel } from "../../src/ui/press-words";
import { WhichLightsPage } from "../../src/ui/which-lights";
import { device, lightCapability } from "../moods/home";

// A press for a floor's lights: the remote's floor among Which lights'
// places, its lights, and a choice that goes with the floor.

const places: Places = {
  home: {
    name: "Home",
    timeZone: "UTC",
    temperatureUnit: "celsius",
    hourCycle: "24h",
  },
  floors: [
    { id: "ground", name: "Ground floor", level: 0 },
    { id: "first", name: "First floor", level: 1 },
  ],
  rooms: [
    { id: "office", name: "Office", floorId: "ground" },
    { id: "kitchen", name: "Kitchen", floorId: "ground" },
    { id: "bedroom", name: "Bedroom", floorId: "first" },
  ],
  zones: [{ id: "front", name: "Front", roomIds: ["office"] }],
};

const remote = device("remote", "office", []);
const devices: DeviceInfo[] = [
  device("desk", "office", [lightCapability({ on: false })]),
  device("counter", "kitchen", [lightCapability({ on: false })]),
  device("bed", "bedroom", [lightCapability({ on: false })]),
];

let container: HTMLDivElement;
let root: Root;
const onPlace = vi.fn(async (_place: PressPlace) => true);

async function show(place: PressPlace, currentPlaces: Places = places) {
  await act(async () => {
    root.render(
      <WhichLightsPage
        device={remote}
        back="Double press"
        place={place}
        places={currentPlaces}
        devices={devices}
        doing="Turn on or off"
        dims={false}
        isSaving={false}
        problem={null}
        onBack={() => undefined}
        onPlace={onPlace}
      />,
    );
  });
}

const options = () =>
  [...container.querySelectorAll('[role="radio"]')].map(
    (each) => each.textContent,
  );

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onPlace.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("Which lights", () => {
  it("offers the remote's room, then its floor, then its zones and all lights", async () => {
    await show({ kind: "room", id: "office" });
    expect(options()).toEqual([
      "Office",
      "Ground floor",
      "Front",
      "All lights",
      "Some lights",
    ]);

    const floor = [...container.querySelectorAll('[role="radio"]')].find(
      (each) => each.textContent === "Ground floor",
    ) as HTMLElement;
    await act(async () => floor.click());
    expect(onPlace).toHaveBeenCalledWith({ kind: "floor", id: "ground" });
  });

  it("keeps showing a floor chosen before the remote moved to another", async () => {
    await show({ kind: "floor", id: "first" });
    expect(options()).toContain("First floor");
    expect(
      container.querySelector('[role="radio"][aria-checked="true"]')
        ?.textContent,
    ).toBe("First floor");
  });
});

describe("Some lights", () => {
  it("starts from the floor's lights as they are now, after a room moved off it", async () => {
    await show({ kind: "floor", id: "ground" });
    // The kitchen moves upstairs while the page is open.
    await show(
      { kind: "floor", id: "ground" },
      {
        ...places,
        rooms: places.rooms.map((room) =>
          room.id === "kitchen" ? { ...room, floorId: "first" } : room,
        ),
      },
    );
    const some = [...container.querySelectorAll('[role="radio"]')].find(
      (each) => each.textContent === "Some lights",
    ) as HTMLElement;
    await act(async () => some.click());
    expect(onPlace).toHaveBeenCalledWith({
      kind: "lights",
      lights: [{ device: "desk", capability: "light" }],
    });
  });

  it("opens with nothing chosen once every room has left the floor", async () => {
    await show({ kind: "floor", id: "ground" });
    await show(
      { kind: "floor", id: "ground" },
      {
        ...places,
        rooms: places.rooms.map((room) => ({ ...room, floorId: "first" })),
      },
    );
    const some = [...container.querySelectorAll('[role="radio"]')].find(
      (each) => each.textContent === "Some lights",
    ) as HTMLElement;
    await act(async () => some.click());
    expect(onPlace).not.toHaveBeenCalled();
    expect(
      container.querySelectorAll('[role="checkbox"]').length,
    ).toBeGreaterThan(0);
    expect(
      container.querySelectorAll('[role="checkbox"][aria-checked="true"]'),
    ).toHaveLength(0);
  });
});

describe("a press for a floor", () => {
  it("is for the lights of the rooms on it, and reads as its name", () => {
    expect(lightsOf({ kind: "floor", id: "ground" }, devices, places)).toEqual([
      { device: "counter", capability: "light" },
      { device: "desk", capability: "light" },
    ]);
    expect(placeLabel({ kind: "floor", id: "ground" }, places, devices)).toBe(
      "Ground floor",
    );
  });

  it("goes back to the remote's default once the floor is removed", () => {
    const choice = {
      kind: "lights",
      place: { kind: "floor", id: "ground" },
      to: "off",
    } as const;
    const lights = new Set<string>();
    expect(stillThere(choice, places, new Set(), lights)).toBe(choice);
    expect(
      stillThere(choice, { ...places, floors: [] }, new Set(), lights),
    ).toBeNull();
  });
});

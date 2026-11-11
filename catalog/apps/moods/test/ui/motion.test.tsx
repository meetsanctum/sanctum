// @vitest-environment jsdom
import type { DeviceInfo, Places } from "@meetsanctum/app-sdk";
import { AppScope, type PageProps } from "@meetsanctum/ui-sdk";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RoomMotion } from "../../src/motion/room-motion.js";
import { minutesWords } from "../../src/ui/motion-words";
import { MainPage } from "../../src/ui/pages";
import { RoomMoodsPage } from "../../src/ui/room-moods";
import type { RoomSchedule } from "../../src/ui/schedules";
import { MoodsProvider } from "../../src/ui/state";
import {
  device,
  illuminanceCapability,
  lightCapability,
  occupancyCapability,
} from "../moods/home";
import { fakeClient } from "./support";

// The Motion section of Moods' page for a room, in each of its states, and
// what a room's line on Moods' main page says of it.

const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  zones: [],
  rooms: [
    { id: "office", name: "Office", floorId: null },
    { id: "living", name: "Living room", floorId: null },
    { id: "stairs", name: "Stairs", floorId: null },
    { id: "hall", name: "Hall", floorId: null },
    { id: "bedroom", name: "Bedroom", floorId: null },
  ],
};

const named = (each: DeviceInfo, name: string) => ({ ...each, name });
const lampIn = (room: string) =>
  device(`${room}-lamp`, room, [lightCapability({ on: false })]);
const homeDevices = (): DeviceInfo[] => [
  ...places.rooms.map((room) => lampIn(room.id)),
  named(
    device("office-motion", "office", [
      occupancyCapability(false),
      illuminanceCapability(318),
    ]),
    "Office motion sensor",
  ),
  named(
    device("stairs-motion", "stairs", [occupancyCapability(false)]),
    "Stairs motion sensor",
  ),
  named(
    device("hall-motion", "hall", [
      occupancyCapability(false),
      illuminanceCapability(40),
    ]),
    "Hall motion sensor",
  ),
  named(device("hall-2", "hall", [occupancyCapability(true)]), "Hall sensor 2"),
  named(
    device(
      "bedroom-motion",
      "bedroom",
      [occupancyCapability(false), illuminanceCapability(3)],
      "offline",
    ),
    "Bedroom motion sensor",
  ),
];

let root: Root;
let container: HTMLDivElement;
let client: ReturnType<typeof fakeClient>;
let motion: Map<string, RoomMotion>;
const open = vi.fn();
const back = vi.fn();

const still = (roomId: string): RoomMotion => ({
  roomId,
  turnOn: false,
  darkerThan: null,
  turnOffAfter: null,
});
const scheduleOf = (roomId: string): RoomSchedule => ({
  roomId,
  scheduled: [],
  turnOn: "followSchedule",
  snapshot: null,
});

function answer(action: string, input: Record<string, unknown>) {
  switch (action) {
    case "moods.moods":
      return Promise.resolve([]);
    case "moods.schedules":
      return Promise.resolve(places.rooms.map((room) => scheduleOf(room.id)));
    case "moods.motion":
      return Promise.resolve([...motion.values()]);
    case "moods.setMotion": {
      const { roomId, ...change } = input as { roomId: string };
      const next = { ...(motion.get(roomId) ?? still(roomId)), ...change };
      motion.set(roomId, next);
      return Promise.resolve(next);
    }
    default:
      return Promise.resolve({ switched: 1, failed: [] });
  }
}

async function show(
  Page: ComponentType<PageProps>,
  params: PageProps["params"],
  devices = homeDevices(),
  // What Moods holds, when a test takes some of it away.
  permissions?: string[],
) {
  client = fakeClient();
  if (permissions) client.app.permissions = permissions;
  client.devices.mockResolvedValue(devices);
  client.places.mockResolvedValue(places);
  client.call.mockImplementation(answer);
  await act(async () => {
    root.render(
      <AppScope client={client}>
        <MoodsProvider>
          <Page
            params={params}
            open={open}
            back={back}
            openSettings={() => {}}
          />
        </MoodsProvider>
      </AppScope>,
    );
  });
}

const section = () =>
  container.querySelector('section[aria-labelledby="motion-heading"]')!;
// The words after the section's card.
const foot = () => section().nextElementSibling as HTMLElement;
const hint = () =>
  section().querySelector("h2")?.nextElementSibling?.textContent ?? null;
const switches = () =>
  [...section().querySelectorAll('[role="switch"]')] as HTMLButtonElement[];
const switchNamed = (name: string) =>
  switches().find(
    (each) =>
      container.querySelector(`#${each.getAttribute("aria-labelledby")}`)
        ?.textContent === name,
  )!;
const describedBy = (element: Element) =>
  container.querySelector(`#${element.getAttribute("aria-describedby")}`)
    ?.textContent;
const selectNamed = (name: string) =>
  [...section().querySelectorAll("select")].find(
    (each) =>
      container.querySelector(`#${each.getAttribute("aria-labelledby")}`)
        ?.textContent === name,
  );
const turningOn = () => switchNamed("Turn the lights on with motion");
const turningOff = () => switchNamed("Turn the lights off with no motion");
const darker = () => selectNamed("Only when it's darker than");
const after = () => selectNamed("After no motion for");

async function press(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

const calls = () =>
  client.call.mock.calls
    .filter(([id]) => id === "moods.setMotion")
    .map(([, input]) => input);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  motion = new Map(places.rooms.map((room) => [room.id, still(room.id)]));
  open.mockReset();
  back.mockReset();
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

describe("a room's Motion section", () => {
  it("names its motion sensor, with both switches off at first", async () => {
    await show(RoomMoodsPage, { placeId: "office" });

    expect(section().querySelector("h2")?.textContent).toBe("Motion");
    expect(hint()).toBe("Office motion sensor");
    expect(switches().map((each) => each.getAttribute("aria-checked"))).toEqual(
      ["false", "false"],
    );
    expect(describedBy(turningOn())).toBe("When every light in Office is off");
    expect(describedBy(turningOff())).toBe(
      "Every light in Office, however it came on",
    );
    expect(darker()).toBeUndefined();
    expect(after()).toBeUndefined();
    expect(foot().textContent).toBe(
      "With motion, the lights come on as turning Office on brings. These run as two of the home's automations, changed only here.",
    );
  });

  it("turns the lights on with motion, below a light level once chosen", async () => {
    await show(RoomMoodsPage, { placeId: "office" });

    await press(turningOn());
    expect(calls()).toEqual([{ roomId: "office", turnOn: true }]);
    expect(turningOn().getAttribute("aria-checked")).toBe("true");
    expect(darker()?.value).toBe("any");
    expect(describedBy(darker()!)).toBe("Office reads 320 lx now");
    expect([...darker()!.options].map((each) => each.textContent)).toEqual([
      "Any light level",
      "5 lx",
      "10 lx",
      "30 lx",
      "50 lx",
      "100 lx",
      "200 lx",
    ]);

    await choose(darker()!, "30");
    expect(calls().at(-1)).toEqual({ roomId: "office", darkerThan: 30 });
    expect(darker()?.value).toBe("30");
    await choose(darker()!, "any");
    expect(calls().at(-1)).toEqual({ roomId: "office", darkerThan: null });
  });

  it("asks to see motion as a switch is turned on, and saves nothing on Not now", async () => {
    // Until asked, Moods sees no motion sensor in Office.
    const unseen = homeDevices().filter(
      (device) =>
        !device.capabilities.some(
          (each) => each.kind === "occupancy" || each.kind === "sensor",
        ),
    );
    await show(RoomMoodsPage, { placeId: "office" }, unseen, [
      "places.read",
      "devices.control:light",
      "devices.read:button",
      "workflows.manage",
    ]);

    expect(turningOn().disabled).toBe(false);
    expect(describedBy(turningOn())).toBe(
      "Moods asks to see motion when you turn this on",
    );
    client.ask.mockResolvedValueOnce(false);
    await press(turningOn());
    expect(client.ask).toHaveBeenCalledWith([
      "devices.read:occupancy",
      "workflows.manage",
    ]);
    expect(calls()).toEqual([]);
    expect(turningOn().getAttribute("aria-checked")).toBe("false");

    await press(turningOn());
    expect(calls()).toEqual([{ roomId: "office", turnOn: true }]);
    // Light levels are asked for when one is chosen, and Any needs none.
    expect(describedBy(darker()!)).toBe(
      "Moods asks to see light levels when you choose one",
    );
    await choose(darker()!, "30");
    expect(client.ask).toHaveBeenLastCalledWith(["devices.read:sensor"]);
    expect(calls().at(-1)).toEqual({ roomId: "office", darkerThan: 30 });
  });

  it("turns the lights off after a while with no motion, 10 minutes at first", async () => {
    await show(RoomMoodsPage, { placeId: "office" });

    await press(turningOff());
    expect(calls()).toEqual([{ roomId: "office", turnOffAfter: 10 }]);
    expect(after()?.value).toBe("10");
    expect([...after()!.options].map((each) => each.textContent)).toEqual([
      "2 minutes",
      "5 minutes",
      "10 minutes",
      "15 minutes",
      "30 minutes",
      "1 hour",
    ]);

    await choose(after()!, "2");
    expect(calls().at(-1)).toEqual({ roomId: "office", turnOffAfter: 2 });
    await press(turningOff());
    expect(calls().at(-1)).toEqual({ roomId: "office", turnOffAfter: null });
    expect(after()).toBeUndefined();
  });

  it.each(["on", "off"])(
    "asks before enabling motion's %s switch when only its automations permission is off",
    async (direction) => {
      await show(RoomMoodsPage, { placeId: "office" }, homeDevices(), [
        "places.read",
        "devices.control:light",
        "devices.read:occupancy",
        "devices.read:sensor",
      ]);
      const toggle = direction === "on" ? turningOn : turningOff;
      client.ask.mockResolvedValueOnce(false);

      await press(toggle());
      expect(client.ask).toHaveBeenCalledWith([
        "devices.read:occupancy",
        "workflows.manage",
      ]);
      expect(calls()).toEqual([]);
      expect(toggle().getAttribute("aria-checked")).toBe("false");

      await press(toggle());
      expect(calls()).toEqual([
        direction === "on"
          ? { roomId: "office", turnOn: true }
          : { roomId: "office", turnOffAfter: 10 },
      ]);

      client.ask.mockClear();
      await press(toggle());
      expect(client.ask).not.toHaveBeenCalled();
      expect(toggle().getAttribute("aria-checked")).toBe("false");
    },
  );

  it("dims both switches where no motion sensor sees, and says where to add one", async () => {
    await show(RoomMoodsPage, { placeId: "living" });

    expect(hint()).toBeNull();
    expect(switches().every((each) => each.disabled)).toBe(true);
    expect(describedBy(turningOn())).toBe("Living room has no motion sensor");
    expect(describedBy(turningOff())).toBe("Living room has no motion sensor");
    expect(foot().textContent).toBe(
      "To use these, add a motion sensor to Living room in Settings.",
    );
  });

  it("can still turn off what motion did once its sensor went", async () => {
    motion.set("living", { ...still("living"), turnOn: true });
    await show(RoomMoodsPage, { placeId: "living" });

    expect(turningOn().disabled).toBe(false);
    expect(turningOff().disabled).toBe(true);
    await press(turningOn());
    expect(calls()).toEqual([{ roomId: "living", turnOn: false }]);
  });

  it("dims the light level where its sensor can't read one, whatever was chosen", async () => {
    motion.set("stairs", {
      roomId: "stairs",
      turnOn: true,
      darkerThan: 30,
      turnOffAfter: 2,
    });
    await show(RoomMoodsPage, { placeId: "stairs" });

    expect(darker()?.disabled).toBe(true);
    expect(darker()?.value).toBe("any");
    expect(describedBy(darker()!)).toBe(
      "Its motion sensor doesn't read the light level",
    );
    expect(after()?.value).toBe("2");
  });

  it("says how two sensors share the room", async () => {
    await show(RoomMoodsPage, { placeId: "hall" });

    expect(hint()).toBe("Hall motion sensor and Hall sensor 2");
    expect(foot().textContent).toBe(
      "With two sensors, there's motion if either sees it, and no motion once both have been quiet that long.",
    );
  });

  it("says in red when its sensor is offline, and that it reads nothing meanwhile", async () => {
    motion.set("bedroom", {
      roomId: "bedroom",
      turnOn: true,
      darkerThan: 10,
      turnOffAfter: null,
    });
    await show(RoomMoodsPage, { placeId: "bedroom" });

    expect(darker()?.value).toBe("10");
    expect(describedBy(darker()!)).toBe("No reading while it's offline");
    expect(foot().getAttribute("role")).toBe("status");
    expect(foot().className).toContain("text-destructive");
    expect(foot().querySelector("svg")).not.toBeNull();
    expect(foot().textContent).toBe(
      "Bedroom motion sensor is offline, so motion can't turn the lights on until it's back.",
    );
  });

  it("says which sensor still sees while another is offline", async () => {
    const devices = homeDevices().map((each) =>
      each.id === "hall-2"
        ? { ...each, availability: "offline" as const }
        : each,
    );
    await show(RoomMoodsPage, { placeId: "hall" }, devices);

    expect(foot().textContent).toBe(
      "Hall sensor 2 is offline, so only Hall motion sensor sees motion until it's back.",
    );
  });
});

describe("a room's line on Moods' main page", () => {
  it("says what motion does to its lights", async () => {
    motion.set("office", {
      roomId: "office",
      turnOn: true,
      darkerThan: null,
      turnOffAfter: 10,
    });
    motion.set("stairs", { ...still("stairs"), turnOn: true });
    motion.set("hall", { ...still("hall"), turnOffAfter: 5 });
    await show(MainPage, {});

    const line = (room: string) =>
      [...container.querySelectorAll("button")].find((each) =>
        each.textContent?.startsWith(room),
      )?.textContent;
    expect(line("Office")).toBe("OfficeNo moods yet · On and off with motion");
    expect(line("Stairs")).toBe("StairsNo moods yet · On with motion");
    expect(line("Hall")).toBe("HallNo moods yet · Off with no motion");
    expect(line("Bedroom")).toBe("BedroomNo moods yet");
  });
});

describe("motion's words", () => {
  it("read an hour as one", () => {
    expect(minutesWords(15)).toBe("15 minutes");
    expect(minutesWords(60)).toBe("1 hour");
  });
});

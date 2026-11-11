// @vitest-environment jsdom
import type { DeviceInfo, LightState, Places } from "@meetsanctum/app-sdk";
import { AppScope, type PageProps } from "@meetsanctum/ui-sdk";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Mood } from "../../src/ui/mood-draft";
import { MainPage } from "../../src/ui/pages";
import { RoomMoodsPage } from "../../src/ui/room-moods";
import { ScheduledMoodPage } from "../../src/ui/scheduled-editor";
import type { RoomSchedule } from "../../src/ui/schedules";
import { MoodsProvider } from "../../src/ui/state";
import { fakeClient } from "./support";

// A room's schedule and how its lights turn on, on Moods' page for the
// room, the editor of a scheduled mood, and Moods' main page with every
// room. It is 15:20 on 30 October, in UTC, the home's time zone.

const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  zones: [],
  rooms: [
    { id: "office", name: "Office", floorId: null },
    { id: "kitchen", name: "Kitchen", floorId: null },
  ],
};

function lightDevice(id: string, name: string, state: LightState): DeviceInfo {
  return {
    id,
    name,
    driverName: name,
    driver: "sanctum.zigbee",
    manufacturer: null,
    model: null,
    roomId: "office",
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

const mood = (id: string, name: string, icon: Mood["icon"]): Mood => ({
  id,
  roomId: "office",
  name,
  icon,
  smart: null,
  lights: [{ device: "lamp", capability: "light", state: { on: true } }],
});
const morning = mood("morning", "Morning", "sunrise");
const focus = mood("focus", "Focus", "briefcase");
const library = mood("library", "Library", "book-open");
const evening = mood("evening", "Evening", "sunset");
const night = mood("night", "Night", "moon");

let root: Root;
let container: HTMLDivElement;
let client: ReturnType<typeof fakeClient>;
let schedule: RoomSchedule;
const open = vi.fn();
const back = vi.fn();

function answer(action: string, input: Record<string, unknown>) {
  switch (action) {
    case "moods.moods":
      return Promise.resolve([morning, focus, library, evening, night]);
    case "moods.schedules":
      return Promise.resolve([
        schedule,
        { ...schedule, roomId: "kitchen", scheduled: [] },
      ]);
    case "moods.motion":
      return Promise.resolve([]);
    case "moods.setTurnOn":
      schedule = {
        ...schedule,
        turnOn: input.turnOn as RoomSchedule["turnOn"],
      };
      return Promise.resolve(schedule);
    case "moods.scheduleMood":
    case "moods.unscheduleMood":
      return Promise.resolve(schedule);
    default:
      return Promise.resolve({ switched: 1, failed: [] });
  }
}

async function show(
  Page: ComponentType<PageProps>,
  params: PageProps["params"],
) {
  client = fakeClient();
  client.devices.mockResolvedValue([
    lightDevice("lamp", "Lamp", { on: true, brightness: 40 }),
    lightDevice("desk", "Desk", { on: false, brightness: 70 }),
  ]);
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

const buttons = () => [...container.querySelectorAll("button")];
const row = (text: string) =>
  buttons().find((each) => each.textContent?.startsWith(text));
// A row of the Schedule section, apart from the moods' tiles above it.
const scheduleRow = (text: string) =>
  [
    ...container.querySelectorAll(
      'section[aria-labelledby="schedule-heading"] button',
    ),
  ].find((each) => each.textContent?.startsWith(text)) as
    HTMLButtonElement | undefined;

async function press(found: HTMLElement | undefined) {
  if (!found) throw new Error("No such button");
  await act(async () => {
    found.click();
  });
}

const calls = (action: string) =>
  client.call.mock.calls
    .filter(([id]) => id === action)
    .map(([, input]) => input);

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-30T15:20:00Z"));
  schedule = {
    roomId: "office",
    scheduled: [
      { id: "s1", roomId: "office", moodId: "morning", start: 390, end: 540 },
      { id: "s2", roomId: "office", moodId: "focus", start: 540, end: 1020 },
      { id: "s3", roomId: "office", moodId: "evening", start: 1110, end: 1320 },
      { id: "s4", roomId: "office", moodId: "night", start: 1320, end: 390 },
    ],
    turnOn: "followSchedule",
    snapshot: {
      takenAt: "2026-10-29T23:10:00.000Z",
      lights: [
        { device: "desk", capability: "light" },
        { device: "lamp", capability: "light" },
      ],
    },
  };
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("a room's schedule", () => {
  it("shows the day and each scheduled mood, the one holding now marked", async () => {
    await show(RoomMoodsPage, { placeId: "office" });

    const day = container.querySelector('[role="img"]');
    expect(day?.getAttribute("aria-label")).toBe(
      "Morning 06:30 to 09:00, Focus 09:00 to 17:00, Evening 18:30 to 22:00, Night 22:00 to 06:30, overnight. Now 15:20.",
    );
    expect(scheduleRow("Focus")?.textContent).toBe("Focus09:00 to 17:00Now");
    expect(scheduleRow("Night")?.textContent).toBe(
      "Night22:00 to 06:30, overnight",
    );
    expect(row("Schedule a mood")?.textContent).toBe(
      "Schedule a mood17:00 to 18:00 is free",
    );
  });

  it("opens a scheduled mood, or a new one, in the editor", async () => {
    await show(RoomMoodsPage, { placeId: "office" });

    await press(scheduleRow("Evening"));
    expect(open).toHaveBeenLastCalledWith("scheduled", {
      room: "office",
      id: "s3",
    });
    await press(row("Schedule a mood"));
    expect(open).toHaveBeenLastCalledWith("scheduled", { room: "office" });
  });
});

describe("turning a room's lights on", () => {
  const said = () =>
    container.querySelector('[aria-live="polite"]')?.textContent;

  it("says the scheduled mood comes on while one holds", async () => {
    await show(RoomMoodsPage, { placeId: "office" });

    const chosen = container.querySelector(
      '[role="radio"][aria-checked="true"]',
    );
    expect(chosen?.textContent).toContain("Follow the schedule");
    expect(said()).toBe("Turning the lights on now brings Focus, until 17:00.");
  });

  it("says which lights come back as they were, and since when", async () => {
    schedule = { ...schedule, turnOn: "asTheyWere" };
    await show(RoomMoodsPage, { placeId: "office" });

    expect(said()).toBe(
      "Turning the lights on now brings back Desk and Lamp as they were at 23:10 yesterday.",
    );
  });

  it("says the lights that were on come back where nothing is scheduled now", async () => {
    vi.setSystemTime(new Date("2026-10-30T17:40:00Z"));
    await show(RoomMoodsPage, { placeId: "office" });

    expect(said()).toBe(
      "Turning the lights on now brings back Desk and Lamp, the lights that were on at 23:10 yesterday.",
    );
  });
});

describe("a scheduled mood's editor", () => {
  const selects = () => [...container.querySelectorAll("select")];

  it("starts a new one at the first free hour, with a mood not yet scheduled", async () => {
    await show(ScheduledMoodPage, { room: "office" });

    expect(container.querySelector("h1")?.textContent).toBe("Schedule a mood");
    const [from, to] = selects();
    expect(from?.value).toBe("1020");
    expect(to?.value).toBe("1080");
    const checked = container.querySelector(
      '[role="radio"][aria-checked="true"]',
    );
    expect(checked?.textContent).toContain("Library");
    expect(container.textContent).toContain("1 hour");
  });

  it("dims the starts another scheduled mood holds, and ends only up to the next", async () => {
    await show(ScheduledMoodPage, { room: "office" });
    const [from, to] = selects();

    const option = (select: HTMLSelectElement, value: string) =>
      [...select.options].find((each) => each.value === value)!;
    expect(option(from!, "1005")).toMatchObject({
      disabled: true,
      textContent: "16:45 · Focus",
    });
    expect(option(from!, "1020").disabled).toBe(false);
    expect([...to!.options].map((each) => each.textContent).at(-1)).toBe(
      "18:30",
    );
  });

  it("saves it, and leaves", async () => {
    await show(ScheduledMoodPage, { room: "office" });
    const [from] = selects();
    await choose(from!, "1035");
    await press(row("Night"));

    await press(buttons().find((each) => each.textContent === "Save"));

    expect(calls("moods.scheduleMood")).toEqual([
      { roomId: "office", moodId: "night", start: 1035, end: 1095 },
    ]);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("changes one already scheduled, and takes it off the schedule once asked", async () => {
    await show(ScheduledMoodPage, { room: "office", id: "s3" });
    expect(container.querySelector("h1")?.textContent).toBe("Scheduled mood");
    const [from, to] = selects();
    expect([from?.value, to?.value]).toEqual(["1110", "1320"]);
    expect(container.textContent).toContain("3 hours 30 minutes");

    await press(row("Remove from the schedule"));
    expect(container.textContent).toContain("Take Evening off the schedule?");
    await press(buttons().find((each) => each.textContent === "Remove"));

    expect(calls("moods.unscheduleMood")).toEqual([{ id: "s3" }]);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("leaves for a scheduled mood that went", async () => {
    await show(ScheduledMoodPage, { room: "office", id: "gone" });
    expect(back).toHaveBeenCalledTimes(1);
  });
});

describe("Moods' main page", () => {
  it("lists every room with lights, what holds it now, and opens it", async () => {
    await show(MainPage, {});

    expect(row("Office")?.textContent).toBe(
      "OfficeFocus until 17:00 · 5 moods",
    );
    expect(row("Kitchen")).toBeUndefined();
    await press(row("Office"));
    expect(open).toHaveBeenCalledWith("room", { placeId: "office" });
  });
});

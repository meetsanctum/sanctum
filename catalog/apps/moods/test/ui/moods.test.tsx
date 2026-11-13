// @vitest-environment jsdom
import type {
  DeviceInfo,
  LightState,
  LiveMessage,
  Places,
} from "@meetsanctum/app-sdk";
import { AppScope, type PageProps } from "@meetsanctum/ui-sdk";
import { act, type ComponentType } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MoodPage } from "../../src/ui/mood-editor";
import type { Mood } from "../../src/ui/mood-draft";
import { RoomMoodsPage } from "../../src/ui/room-moods";
import type { RoomSchedule } from "../../src/ui/schedules";
import { MoodsProvider } from "../../src/ui/state";
import { fakeClient } from "./support";

// Moods' page for a room's moods, which Edit beside a room page's Moods
// heading opens, and the mood editor it opens. The room page's section of
// moods, which runs them, is the shell's (apps/client).

const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  zones: [],
  rooms: [{ id: "office", name: "Office", floorId: null }],
};

function lightDevice(id: string, name: string, state: LightState): DeviceInfo {
  return {
    id,
    name,
    driverName: name,
    type: "light",
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

const lamp = lightDevice("lamp", "Lamp", { on: true, brightness: 40 });
const desk = lightDevice("desk", "Desk", { on: false, brightness: 70 });

const relax: Mood = {
  id: "relax",
  roomId: "office",
  name: "Relax",
  icon: "armchair",
  smart: null,
  lights: [
    { device: "desk", capability: "light", state: { on: false } },
    {
      device: "lamp",
      capability: "light",
      state: { on: true, brightness: 40 },
    },
  ],
};
const work: Mood = {
  id: "work",
  roomId: "office",
  name: "Work",
  icon: "briefcase",
  smart: null,
  lights: [
    {
      device: "desk",
      capability: "light",
      state: { on: true, brightness: 100 },
    },
    {
      device: "lamp",
      capability: "light",
      state: { on: true, brightness: 100 },
    },
  ],
};

// What puts the office back after a preview: the desk off and coming back
// at 70%, the lamp on at 40%.
const putBack = [
  {
    device: "desk",
    capability: "light",
    state: { on: false, brightness: 70 },
  },
  { device: "lamp", capability: "light", state: { on: true, brightness: 40 } },
];

const aurora: Mood = {
  id: "aurora",
  roomId: "office",
  name: "Aurora",
  icon: "sparkles",
  lights: [],
  smart: { definition: "aurora", brightness: 70, off: [] },
};

let root: Root;
let container: HTMLDivElement;
let client: ReturnType<typeof fakeClient>;
let moods: Mood[];
// The devices the core answers with.
let devices: DeviceInfo[];
const officeSchedule: RoomSchedule = {
  roomId: "office",
  scheduled: [],
  turnOn: "followSchedule",
  snapshot: null,
};
let refusals: Record<string, string>;
const open = vi.fn();
const back = vi.fn();

function answer(action: string, input: { id?: string }) {
  if (refusals[action]) {
    return Promise.reject(
      Object.assign(new Error("refused"), { code: refusals[action] }),
    );
  }
  switch (action) {
    case "moods.moods":
      return Promise.resolve(moods);
    case "moods.schedules":
      return Promise.resolve([officeSchedule]);
    case "moods.motion":
      return Promise.resolve([]);
    case "moods.deleteMood":
      moods = moods.filter((mood) => mood.id !== input.id);
      return Promise.resolve({ id: input.id });
    case "moods.createMood":
      return Promise.resolve({ ...input, id: "new" });
    case "moods.assignSmartMood":
      return Promise.resolve({ ...aurora, id: "new" });
    case "moods.updateSmartMood":
      return Promise.resolve(aurora);
    case "moods.orderMoods":
      return Promise.resolve({ moodIds: [] });
    default:
      return Promise.resolve({ switched: 1, failed: [] });
  }
}

async function show(
  Page: ComponentType<PageProps>,
  params: PageProps["params"],
) {
  client = fakeClient();
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

const button = (text: string) =>
  [...container.querySelectorAll("button")].find(
    (each) =>
      each.textContent === text || each.getAttribute("aria-label") === text,
  );

async function press(text: string) {
  const found = button(text);
  if (!found) throw new Error(`No button ${text}`);
  await act(async () => {
    found.click();
  });
}

// A tile, by the name it starts with.
async function pressTile(name: string) {
  const found = [...container.querySelectorAll("button")].find((each) =>
    each.textContent?.startsWith(name),
  );
  if (!found) throw new Error(`No tile ${name}`);
  await act(async () => {
    found.click();
  });
}

const calls = (action: string) =>
  client.call.mock.calls
    .filter(([id]) => id === action)
    .map(([, input]) => input);

async function report(device: DeviceInfo) {
  const listener = client.subscribe.mock.calls.at(-1) as unknown as [
    { message: (message: LiveMessage) => void },
  ];
  await act(async () => {
    listener[0].message({ type: "device", id: device.id, device });
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  moods = [relax, work];
  devices = [desk, lamp];
  refusals = {};
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

describe("a room's moods", () => {
  it("are put in order with the arrow keys, and a tap opens the editor", async () => {
    await show(RoomMoodsPage, { placeId: "office" });
    expect(container.querySelector("h1")?.textContent).toBe("Office moods");
    await press("New mood");
    expect(open).toHaveBeenLastCalledWith("mood", { room: "office" });

    await act(async () => {
      button("Edit Relax")!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(calls("moods.orderMoods")).toEqual([
      { roomId: "office", moodIds: ["work", "relax"] },
    ]);

    await press("Edit Work");
    expect(open).toHaveBeenLastCalledWith("mood", {
      room: "office",
      id: "work",
    });
    expect(calls("moods.runMood")).toEqual([]);
  });

  it("end with Done beside the title, their way out", async () => {
    await show(RoomMoodsPage, { placeId: "office" });
    await press("Done");
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("offer a first mood in a room with lights", async () => {
    moods = [];
    await show(RoomMoodsPage, { placeId: "office" });
    expect(button("New mood")).toBeDefined();
  });

  it("offer none in a room without lights, and say why", async () => {
    moods = [];
    devices = [];
    await show(RoomMoodsPage, { placeId: "office" });
    expect(button("New mood")).toBeUndefined();
    expect(container.textContent).toContain("it has none yet");
  });

  it("leave for a room that went", async () => {
    await show(RoomMoodsPage, { placeId: "attic" });
    expect(back).toHaveBeenCalledTimes(1);
  });
});

async function typeName(text: string) {
  const input = container.querySelector<HTMLInputElement>("#mood-name")!;
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setValue.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("the mood editor", () => {
  it("keeps the captured draft when live lights change before the first edit", async () => {
    await show(MoodPage, { room: "office" });
    await pressTile("From the lights");
    await report(lightDevice("lamp", "Lamp", { on: true, brightness: 90 }));
    await typeName("Reading");
    await press("Save");
    expect(calls("moods.createMood")[0]).toMatchObject({
      lights: relax.lights,
    });
  });

  it("restores lights that arrive during a preview to their arrival state", async () => {
    await show(MoodPage, { room: "office", id: "work" });
    await press("Preview on the lights");
    await report(lightDevice("extra", "Extra", { on: true, brightness: 65 }));
    expect(calls("moods.previewMood").at(-1)).toMatchObject({
      lights: expect.arrayContaining([
        { device: "extra", capability: "light", state: { on: false } },
      ]),
    });
    await press("Cancel");
    expect(calls("moods.previewMood").at(-1)).toMatchObject({
      lights: expect.arrayContaining([
        {
          device: "extra",
          capability: "light",
          state: { on: true, brightness: 65 },
        },
      ]),
    });
  });

  it("captures a new mood from the room's lights as they are", async () => {
    await show(MoodPage, { room: "office" });
    await pressTile("From the lights");
    expect(button("Save")?.disabled).toBe(true);
    await typeName(" Reading ");
    await press("moon");
    await press("Save");
    expect(calls("moods.createMood")).toEqual([
      {
        roomId: "office",
        name: "Reading",
        icon: "moon",
        lights: [
          { device: "desk", capability: "light", state: { on: false } },
          {
            device: "lamp",
            capability: "light",
            state: { on: true, brightness: 40 },
          },
        ],
      },
    ]);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("has Cancel and Save beside its title, its way out, and Delete at its foot", async () => {
    await show(MoodPage, { room: "office", id: "work" });
    const bar = [...container.querySelectorAll("header button")].map(
      (each) => each.textContent,
    );
    expect(bar).toEqual(["Cancel", "Save"]);
    const buttons = [...container.querySelectorAll("button")].map(
      (each) => each.textContent,
    );
    expect(buttons.at(-1)).toBe("Delete mood");
  });

  it("leaves a new mood's first step on Cancel, adding nothing", async () => {
    await show(MoodPage, { room: "office" });
    await press("Cancel");
    expect(back).toHaveBeenCalledTimes(1);
    expect(calls("moods.createMood")).toEqual([]);
    expect(calls("moods.previewMood")).toEqual([]);
  });

  it("previews the draft on the lights as it changes, and puts them back on cancel", async () => {
    await show(MoodPage, { room: "office", id: "work" });
    expect(button("Save")?.disabled).toBe(true);
    await press("Preview on the lights");
    expect(calls("moods.previewMood")).toEqual([
      { roomId: "office", lights: work.lights },
    ]);

    // Desk off in the draft, and on the lights.
    const deskTile = [...container.querySelectorAll("button")].find((each) =>
      each.textContent?.startsWith("Desk"),
    )!;
    expect(deskTile.textContent).toBe("Desk100%");
    await act(async () => {
      deskTile.click();
    });
    expect(calls("moods.previewMood").at(-1)).toEqual({
      roomId: "office",
      lights: [
        { device: "desk", capability: "light", state: { on: false } },
        {
          device: "lamp",
          capability: "light",
          state: { on: true, brightness: 100 },
        },
      ],
    });
    expect(button("Save")?.disabled).toBe(false);

    await press("Cancel");
    // As the lights were when the preview began, the desk off and coming
    // back at 70%, not as the preview left it.
    expect(calls("moods.previewMood").at(-1)).toEqual({
      roomId: "office",
      lights: putBack,
    });
    expect(calls("moods.updateMood")).toEqual([]);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("puts the lights back when the page goes mid-preview", async () => {
    await show(MoodPage, { room: "office", id: "work" });
    await press("Preview on the lights");
    await act(async () => {
      root.render(null);
    });
    expect(calls("moods.previewMood")).toEqual([
      { roomId: "office", lights: work.lights },
      { roomId: "office", lights: putBack },
    ]);
  });

  it("cancels queued draft changes before restoring after an in-flight preview", async () => {
    await show(MoodPage, { room: "office", id: "work" });
    let finish!: () => void;
    const pending = new Promise<{ switched: number; failed: never[] }>(
      (resolve) => {
        finish = () => resolve({ switched: 2, failed: [] });
      },
    );
    client.call.mockReturnValueOnce(pending);
    await press("Preview on the lights");
    const deskTile = [...container.querySelectorAll("button")].find((each) =>
      each.textContent?.startsWith("Desk"),
    )!;
    await act(async () => {
      deskTile.click();
    });
    await press("Cancel");
    expect(back).not.toHaveBeenCalled();
    expect(calls("moods.previewMood")).toHaveLength(1);
    await act(async () => {
      finish();
    });
    expect(calls("moods.previewMood")).toEqual([
      { roomId: "office", lights: work.lights },
      { roomId: "office", lights: putBack },
    ]);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("keeps a saved preview when the editor unmounts", async () => {
    await show(MoodPage, { room: "office" });
    await pressTile("From the lights");
    await typeName("Reading");
    await press("Preview on the lights");
    await press("Save");
    await act(async () => {
      root.render(null);
    });
    expect(calls("moods.previewMood")).toEqual([
      { roomId: "office", lights: relax.lights },
    ]);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("deletes a mood once asked twice, and leaves once", async () => {
    await show(MoodPage, { room: "office", id: "relax" });
    await press("Delete mood");
    expect(calls("moods.deleteMood")).toEqual([]);
    await press("Delete");
    expect(calls("moods.deleteMood")).toEqual([{ id: "relax" }]);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("says when deleting fails, and stays", async () => {
    refusals["moods.deleteMood"] = "conflict";
    await show(MoodPage, { room: "office", id: "relax" });
    await press("Delete mood");
    await press("Delete");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "The mood could not be deleted.",
    );
    expect(back).not.toHaveBeenCalled();
  });
});

describe("smart moods", () => {
  beforeEach(() => {
    // Radix's slider measures itself.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  it("are offered with the lights as they are, the room's own as added", async () => {
    moods = [relax, aurora];
    await show(MoodPage, { room: "office" });
    expect(
      [...container.querySelectorAll("h2")].map((each) => each.textContent),
    ).toEqual(["Your own", "Colour", "Calm", "Energy"]);
    const tile = (name: string) =>
      [...container.querySelectorAll("button")].find((each) =>
        each.textContent?.startsWith(name),
      )!;
    expect(tile("Aurora").disabled).toBe(true);
    expect(tile("Aurora").textContent).toBe("AuroraAdded");
    expect(tile("Library").disabled).toBe(false);
  });

  it("are added with a brightness and a light left off, previewed on the way", async () => {
    await show(MoodPage, { room: "office" });
    await pressTile("Library");
    expect(container.querySelector("h1")?.textContent).toBe("Library");
    await press("Preview on the lights");
    // These lights only dim, so they take the brightness.
    expect(calls("moods.previewMood")).toEqual([
      {
        roomId: "office",
        lights: [
          {
            device: "desk",
            capability: "light",
            state: { on: true, brightness: 50 },
          },
          {
            device: "lamp",
            capability: "light",
            state: { on: true, brightness: 50 },
          },
        ],
      },
    ]);

    await pressTile("Desk");
    const thumb = container.querySelector<HTMLElement>('[role="slider"]')!;
    await act(async () => {
      thumb.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
      );
    });
    expect(calls("moods.previewMood").at(-1)).toEqual({
      roomId: "office",
      lights: [
        { device: "desk", capability: "light", state: { on: false } },
        {
          device: "lamp",
          capability: "light",
          state: { on: true, brightness: 51 },
        },
      ],
    });

    await press("Save");
    expect(calls("moods.assignSmartMood")).toEqual([
      {
        roomId: "office",
        definitionId: "late-night-library-warm-corners",
        brightness: 51,
        off: [{ device: "desk", capability: "light" }],
      },
    ]);
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("change their settings only, once something changed", async () => {
    moods = [aurora];
    await show(MoodPage, { room: "office", id: "aurora" });
    expect(container.querySelector("#mood-name")).toBeNull();
    expect(button("Save")?.disabled).toBe(true);
    await pressTile("Lamp");
    await press("Save");
    expect(calls("moods.updateSmartMood")).toEqual([
      {
        id: "aurora",
        brightness: 70,
        off: [{ device: "lamp", capability: "light" }],
      },
    ]);
  });
});

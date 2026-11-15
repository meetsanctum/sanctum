// @vitest-environment jsdom
import type {
  AppInfo,
  AppSettings,
  CapabilityInfo,
  DeviceInfo,
  EntityInfo,
  LiveMessage,
  Places,
} from "@meetsanctum/app-sdk";
import {
  AppScope,
  type AppClient,
  type LiveListener,
} from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { defaultCurve } from "../../src/settings.js";
import { previewOf, type Preview } from "../../src/preview.js";
import { sunToday } from "../../src/sun.js";
import type { TargetState } from "../../src/target.js";
import ui from "../../src/ui/index";

// Natural light's page: today's curve, and the lights that take a colour
// temperature with where each stands, as both states show it, by room once
// it may read the home's rooms.

const zurich = {
  latitude: 47.3769,
  longitude: 8.5417,
  elevation: null,
  timeZone: "Europe/Zurich",
};
const now = new Date("2026-10-29T09:00:00Z");
const today: Preview = previewOf(defaultCurve, sunToday(zurich, now)!, now);

const light = (colorTemperature: boolean): CapabilityInfo => ({
  id: "light",
  kind: "light",
  features: {
    brightness: true,
    colorTemperature: colorTemperature ? { min: 153, max: 454 } : null,
    color: false,
  },
  state: { on: true, brightness: 80 },
  observed: { on: true, brightness: 80 },
  desired: null,
  sync: "synced",
  setBy: null,
  changedAt: null,
});
const device = (
  id: string,
  name: string,
  colorTemperature = true,
  roomId: string | null = null,
): DeviceInfo => ({
  id,
  name,
  driver: "sanctum.zigbee",
  manufacturer: null,
  model: null,
  roomId,
  driverName: name,
  type: "light",
  availability: "online",
  lastSeenAt: null,
  firmware: null,
  probe: false,
  battery: null,
  batteryLow: null,
  shownAs: null,
  leftAt: null,
  problem: null,
  capabilities: [light(colorTemperature)],
});
const target = (
  id: string,
  status: TargetState["status"],
): EntityInfo<TargetState> => ({
  app: "sanctum.natural-light",
  key: `${id}/light`,
  type: "naturalLight.target",
  name: id,
  state: {
    device: id,
    capability: "light",
    status,
    colorTemperature: status === "waiting" ? null : 290,
    brightness: status === "waiting" ? null : 92,
  },
  updatedAt: now.toISOString(),
});

function fakeClient(options: {
  devices: DeviceInfo[];
  entities: EntityInfo[];
  preview: Preview | null;
  /** The home's rooms; without them, it may not read rooms. */
  places?: Places;
  settings?: AppSettings;
}) {
  const listeners = new Set<LiveListener>();
  const app: AppInfo = {
    id: "sanctum.natural-light",
    name: "Natural light",
    version: "0.1.0",
    icon: { glyph: "sun", color: "sun" },
    pages: ["main"],
    permissions: ["places.location", "devices.control:light"],
    requests: [],
    state: "running",
    settings: null,
    provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
  };
  const call = vi.fn(
    async (action: string, _input: unknown): Promise<unknown> =>
      action === "naturalLight.preview" ? options.preview : null,
  );
  const client: AppClient = {
    app,
    call: call as AppClient["call"],
    places: vi.fn(async () => {
      if (!options.places) throw new Error("It needs places.read");
      return options.places;
    }),
    devices: vi.fn(async () => options.devices),
    command: vi.fn(),
    entities: vi.fn(async () => options.entities),
    settings: vi.fn(async () => options.settings ?? {}),
    capturePresses: vi.fn(),
    ask: vi.fn(async () => true),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const push = (message: LiveMessage) => {
    for (const listener of listeners) listener.message?.(message);
  };
  const refresh = () => {
    for (const listener of listeners) listener.refresh?.();
  };
  return { client, call, push, refresh };
}

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function show(client: AppClient, openSettings = () => undefined) {
  const Page = ui.pages.main!;
  await act(async () => {
    root.render(
      <AppScope client={client}>
        <Page
          params={{}}
          open={() => undefined}
          back={() => undefined}
          openSettings={openSettings}
        />
      </AppScope>,
    );
  });
  return container.textContent ?? "";
}

const rows = () =>
  [...container.querySelectorAll("li")].map((each) => each.textContent);

describe("natural light's page", () => {
  it("keeps the refreshed status when an older read finishes later", async () => {
    const { client, refresh } = fakeClient({
      devices: [device("office", "Office light")],
      entities: [target("office", "paused")],
      preview: today,
    });
    let finishOlder!: (entities: EntityInfo[]) => void;
    const older = new Promise<EntityInfo[]>(
      (resolve) => (finishOlder = resolve),
    );
    vi.mocked(client.entities).mockImplementationOnce(() => older);
    await show(client);

    await act(async () => refresh());
    expect(rows()).toEqual([
      "Office lightPaused until it’s switched offResume",
    ]);

    await act(async () => finishOlder([]));
    expect(rows()).toEqual([
      "Office lightPaused until it’s switched offResume",
    ]);
  });

  it("says where to set the location before the home has one", async () => {
    const text = await show(
      fakeClient({ devices: [], entities: [], preview: null }).client,
    );

    expect(text).toContain(
      "Natural light follows the sun once the home’s location is set in Settings.",
    );
    expect(text).toContain("No lights that change colour temperature yet.");
  });

  it("shows today's curve and where each light stands", async () => {
    const text = await show(
      fakeClient({
        devices: [
          device("office", "Office light"),
          device("hall", "Hall light"),
          device("desk", "Desk lamp"),
          device("plain", "Plain bulb", false),
        ],
        entities: [target("office", "following"), target("hall", "paused")],
        preview: today,
      }).client,
    );

    expect(text).toContain(
      `${(Math.round(today.now.kelvin / 50) * 50).toLocaleString()} K`,
    );
    expect(text).toMatch(/Sunrise\s*0?7:04/);
    // The peak, which need not be the brightest time: night can be set
    // brighter.
    expect(text).toMatch(/Peak\s*\d/);
    // In name order; a light without colour temperature is left out.
    expect(rows()).toEqual([
      "Desk lampNot following",
      "Hall lightPaused until it’s switched offResume",
      "Office lightFollowing · 3,450 K at 92%",
    ]);
  });

  it("says so while natural light is off, keeping each light's switch", async () => {
    await show(
      fakeClient({
        devices: [device("office", "Office light")],
        entities: [target("office", "off")],
        preview: today,
      }).client,
    );

    expect(rows()).toEqual(["Office lightNatural light is off"]);
    expect(
      container
        .querySelector('[aria-label="Office light follows natural light"]')
        ?.getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("draws a changing temperature when the night is cooler than the peak", async () => {
    const preview = previewOf(
      { ...defaultCurve, lowKelvin: 5500, highKelvin: 2000 },
      sunToday(zurich, now)!,
      now,
    );
    await show(fakeClient({ devices: [], entities: [], preview }).client);

    const points = container.querySelector("polyline")!.getAttribute("points")!;
    const heights = points
      .split(" ")
      .map((point) => Number(point.split(",")[1]));
    expect(heights[0]).toBeLessThan(Math.max(...heights));
    expect(new Set(heights).size).toBeGreaterThan(1);
  });

  it("follows a light with its switch, and resumes a paused one", async () => {
    const { client, call, push } = fakeClient({
      devices: [device("office", "Office light"), device("hall", "Hall light")],
      entities: [target("hall", "paused")],
      preview: today,
    });
    await show(client);

    const office = container.querySelector<HTMLButtonElement>(
      '[aria-label="Office light follows natural light"]',
    )!;
    expect(office.getAttribute("aria-checked")).toBe("false");
    await act(async () => office.click());
    expect(call).toHaveBeenCalledWith("naturalLight.follow", {
      device: "office",
      capability: "light",
      follow: true,
    });

    const resume = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Resume",
    )!;
    await act(async () => resume.click());
    expect(call).toHaveBeenCalledWith("naturalLight.resume", {
      device: "hall",
      capability: "light",
    });

    // The light's entity arrives live once it follows.
    await act(async () =>
      push({
        type: "entity",
        app: "sanctum.natural-light",
        key: "office/light",
        entity: target("office", "following"),
        was: null,
      }),
    );
    expect(office.getAttribute("aria-checked")).toBe("true");
  });

  it("draws the curve again when its settings change", async () => {
    const line = () =>
      container.querySelector("polyline")!.getAttribute("points");
    // An early riser peaks a third of the way into the day.
    const curve = { ...defaultCurve, shape: "early_riser" as const };
    const earlyRiser = previewOf(curve, sunToday(zurich, now)!, now);
    await show(
      fakeClient({ devices: [], entities: [], preview: earlyRiser }).client,
    );
    const drawn = line();

    const options = {
      devices: [],
      entities: [],
      preview: today as Preview | null,
    };
    const { client, push } = fakeClient(options);
    await show(client);
    expect(line()).not.toBe(drawn);
    // Its settings are opened by the shell's button, not one of its own.
    expect(
      container.querySelector('[aria-label="Natural light settings"]'),
    ).toBeNull();

    options.preview = earlyRiser;
    await act(async () =>
      push({ type: "settings", app: "sanctum.natural-light", settings: curve }),
    );
    expect(line()).toBe(drawn);
  });

  describe("by room", () => {
    const places: Places = {
      home: {
        name: "Home",
        timeZone: "Europe/Zurich",
        temperatureUnit: "celsius",
      },
      floors: [],
      zones: [],
      rooms: [
        { id: "office", name: "Office", floorId: null },
        { id: "hall", name: "Hall", floorId: null },
        { id: "attic", name: "Attic", floorId: null },
      ],
    };
    const devices = [
      device("ceiling", "Ceiling", true, "office"),
      device("desk", "Desk lamp", true, "office"),
      device("hall", "Hall light", true, "hall"),
      device("loose", "Loose lamp", true, null),
    ];
    const headings = () =>
      [...container.querySelectorAll("h2")]
        .map((each) => each.textContent)
        .filter((text) => text !== "Today");
    const roomSwitch = (room: string) =>
      container.querySelector<HTMLButtonElement>(
        `[aria-label="Lights in ${room} follow natural light"]`,
      )!;

    it.each(["answers", "fails"])(
      "keeps live room names when an older read %s later",
      async (outcome) => {
        const { client, push } = fakeClient({
          devices,
          entities: [],
          preview: today,
          places,
        });
        let finishOlder!: (places: Places) => void;
        let failOlder!: (error: Error) => void;
        vi.mocked(client.places).mockImplementationOnce(
          () =>
            new Promise<Places>((resolve, reject) => {
              finishOlder = resolve;
              failOlder = reject;
            }),
        );
        await show(client);
        const renamed = {
          ...places,
          rooms: places.rooms.map((room) =>
            room.id === "office" ? { ...room, name: "Study" } : room,
          ),
        };
        await act(async () => push({ type: "places", places: renamed }));
        expect(headings()).toEqual(["Study", "Hall", "No room"]);

        await act(async () => {
          if (outcome === "answers") finishOlder(places);
          else failOlder(new Error("Connection lost"));
        });

        expect(headings()).toEqual(["Study", "Hall", "No room"]);
      },
    );

    it.each(["answers", "fails"])(
      "keeps refreshed rooms when an older read %s later",
      async (outcome) => {
        const { client, refresh } = fakeClient({
          devices,
          entities: [],
          preview: today,
          places,
        });
        let finishOlder!: (places: Places) => void;
        let failOlder!: (error: Error) => void;
        vi.mocked(client.places).mockImplementationOnce(
          () =>
            new Promise<Places>((resolve, reject) => {
              finishOlder = resolve;
              failOlder = reject;
            }),
        );
        await show(client);
        await act(async () => refresh());
        expect(headings()).toEqual(["Office", "Hall", "No room"]);

        await act(async () => {
          if (outcome === "answers") finishOlder({ ...places, rooms: [] });
          else failOlder(new Error("Connection lost"));
        });

        expect(headings()).toEqual(["Office", "Hall", "No room"]);
      },
    );

    it("lists the lights by room in the home's order, those in no room last, with how many follow", async () => {
      await show(
        fakeClient({
          devices,
          entities: [target("ceiling", "following"), target("hall", "paused")],
          preview: today,
          places,
        }).client,
      );

      expect(headings()).toEqual(["Office", "Hall", "No room"]);
      expect(container.textContent).toContain("1 of 2 lights follows");
      expect(container.textContent).toContain("Its light follows");
      expect(container.textContent).toContain("Not following");
      expect(roomSwitch("Office").getAttribute("aria-checked")).toBe("true");
      expect(roomSwitch("No room").getAttribute("aria-checked")).toBe("false");
      expect(rows()).toEqual([
        "CeilingFollowing · 3,450 K at 92%",
        "Desk lampNot following",
        "Hall lightPaused until it’s switched offResume",
        "Loose lampNot following",
      ]);
    });

    it("has every light in a room follow or leaves them out with its switch", async () => {
      const { client, call } = fakeClient({
        devices,
        entities: [target("ceiling", "following")],
        preview: today,
        places,
      });
      call.mockImplementation(async (action: string) =>
        action === "naturalLight.followRoom" ? { failed: [] } : null,
      );
      await show(client);

      await act(async () => roomSwitch("Office").click());
      expect(call).toHaveBeenCalledWith("naturalLight.followRoom", {
        placeId: "office",
        follow: false,
      });
      await act(async () => roomSwitch("No room").click());
      expect(call).toHaveBeenCalledWith("naturalLight.followRoom", {
        placeId: null,
        follow: true,
      });
    });

    it("says so beside a room when a light couldn't be changed", async () => {
      const { client, call } = fakeClient({
        devices,
        entities: [],
        preview: today,
        places,
      });
      call.mockImplementation(async (action: string) =>
        action === "naturalLight.followRoom"
          ? { failed: [{ device: "desk", capability: "light" }] }
          : null,
      );
      await show(client);

      await act(async () => roomSwitch("Office").click());
      expect(container.textContent).toContain("Couldn’t change every light");
    });
  });

  it("says first that natural light is off, with a link to its settings", async () => {
    const openSettings = vi.fn();
    await show(
      fakeClient({
        devices: [device("office", "Office light")],
        entities: [target("office", "off")],
        preview: today,
        settings: { on: false },
      }).client,
      openSettings,
    );

    expect(container.textContent).toContain(
      "Natural light is offLights keep the look they have and don’t change with the day.",
    );
    const link = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Open settings",
    )!;
    await act(async () => link.click());
    expect(openSettings).toHaveBeenCalledTimes(1);
  });
});

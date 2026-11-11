// @vitest-environment jsdom
import type {
  AppInfo,
  CapabilityInfo,
  DeviceInfo,
  EntityInfo,
  LiveMessage,
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
// temperature with where each stands, as both states show it.

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
): DeviceInfo => ({
  id,
  name,
  driver: "sanctum.zigbee",
  manufacturer: null,
  model: null,
  roomId: null,
  driverName: name,
  availability: "online",
  lastSeenAt: null,
  firmware: null,
  probe: false,
  battery: null,
  leftAt: null,
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
  const call = vi.fn(async (action: string, _input: unknown) =>
    action === "naturalLight.preview" ? options.preview : null,
  );
  const client: AppClient = {
    app,
    call: call as AppClient["call"],
    places: vi.fn(),
    devices: vi.fn(async () => options.devices),
    command: vi.fn(),
    entities: vi.fn(async () => options.entities),
    settings: vi.fn(async () => ({})),
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

async function show(client: AppClient) {
  const Page = ui.pages.main!;
  await act(async () => {
    root.render(
      <AppScope client={client}>
        <Page
          params={{}}
          open={() => undefined}
          back={() => undefined}
          openSettings={() => undefined}
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
});

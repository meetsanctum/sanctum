// @vitest-environment jsdom
import type {
  DeviceInfo,
  LightFeatures,
  LightState,
  LightsResult,
} from "@meetsanctum/app-sdk";
import { createLiveFeed, lightColour, type Tile } from "@meetsanctum/ui-sdk";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { useOpenDevice, type OpenDevice } from "../src/open-device";
import { RoomPage } from "../src/place-pages";
import {
  roomLightsKey,
  roomLightsTile,
  roomOfLightsKey,
} from "../src/room-lights";
import { RoomLightsDetail } from "../src/room-lights-detail";
import { useSectionEntities } from "../src/room-sections";
import { useDevices } from "../src/use-devices";
import { motionCapability } from "./device-tiles-fixtures";
import { light, places } from "./place-pages-fixtures";

vi.mock("../src/core-fetch", () => ({
  coreJson: vi.fn(),
  currentCredential: () => ({ token: "client" }),
}));

// A room's Lights tile: every light in the room as one, first among its
// lights, with a detail of a light's controls for all of them.

const dimOnly: LightFeatures = {
  brightness: true,
  colorTemperature: null,
  color: false,
};
const withColour: LightFeatures = {
  brightness: true,
  colorTemperature: { min: 153, max: 500 },
  color: true,
};
const plainLight: LightFeatures = { ...dimOnly, brightness: false };

// A light in the office, off or on with its reported state.
function officeLight(
  id: string,
  level: number | LightState | null,
  features = dimOnly,
): DeviceInfo {
  const base = light(id, id, "office", level !== null);
  const state =
    typeof level === "number"
      ? { on: true, brightness: level }
      : (level ?? { on: false });
  return {
    ...base,
    capabilities: [
      { ...base.capabilities[0]!, features, state, observed: state },
    ] as DeviceInfo["capabilities"],
  };
}

const tileOf = (overrides: Partial<Tile>): Tile => ({
  key: overrides.key ?? "lamp/light",
  deviceId: "lamp",
  capabilityId: "light",
  kind: "light",
  roomId: "office",
  name: "Lamp",
  status: "Off",
  on: false,
  look: "off",
  dims: true,
  disabled: false,
  ...overrides,
});

describe("a room's Lights tile's words", () => {
  it.each([
    [[tileOf({})], "Off"],
    [[tileOf({ disabled: true })], "Offline"],
    [[tileOf({ on: true, brightness: 40 })], "40%"],
    [[tileOf({ on: true, dims: false })], "On"],
    [
      [
        tileOf({ key: "a", on: true, brightness: 40 }),
        tileOf({ key: "b", on: true, brightness: 80 }),
      ],
      "2 on · 60%",
    ],
    [
      [
        tileOf({ key: "a", on: true, brightness: 60 }),
        tileOf({ key: "b", on: true, brightness: 80 }),
        tileOf({ key: "c" }),
        tileOf({ key: "d", disabled: true }),
      ],
      "2 of 3 on · 70%",
    ],
  ])("say how many are on and at what level: %#", (lights, status) => {
    expect(roomLightsTile(lights, "office")?.status).toBe(status);
  });

  it("is lit in its lights' colour when they share one, and warm white when not", () => {
    const red = tileOf({ key: "a", on: true, colour: "#ff8080" });
    const blue = tileOf({ key: "b", on: true, colour: "#8080ff" });
    expect(roomLightsTile([red, { ...red, key: "c" }], "office")?.colour).toBe(
      "#ff8080",
    );
    expect(roomLightsTile([red, blue], "office")?.colour).toBe(
      lightColour({ on: true }),
    );
    expect(roomLightsTile([], "office")).toBeUndefined();
  });
});

let root: Root;
let container: HTMLDivElement;
let live: ReturnType<typeof createLiveFeed>;
let devices: DeviceInfo[];

function Harness() {
  const shown = useDevices(live);
  const entities = useSectionEntities(live, [], shown.fail);
  const [opened, setOpened] = useState<string | null>(null);
  const roomId = roomOfLightsKey(opened);
  return (
    <>
      <RoomPage
        roomId="office"
        devices={shown}
        apps={[]}
        entities={entities}
        openDevice={(tile) => setOpened(tile.key)}
        back={() => {}}
      />
      {roomId && (
        <RoomLightsDetail
          container={container}
          roomId={roomId}
          open
          onClose={() => setOpened(null)}
          onCovering={() => {}}
          devices={shown}
        />
      )}
    </>
  );
}

async function show() {
  await act(async () => {
    root.render(<Harness />);
  });
  await act(async () => {
    live.refresh();
  });
}

const dialog = () => container.querySelector('[role="dialog"]');
const button = (label: string, within: ParentNode = container) =>
  [...within.querySelectorAll("button")].find(
    (each) => (each.getAttribute("aria-label") ?? each.textContent) === label,
  ) as HTMLButtonElement | undefined;
const posted = () =>
  vi
    .mocked(coreJson)
    .mock.calls.filter(([path]) => path === "/api/devices/lights")
    .map(([, init]) => init?.json);
const tabs = () =>
  [...dialog()!.querySelectorAll('[role="tab"]')].map((each) =>
    each.getAttribute("aria-label"),
  );

async function click(element: HTMLElement | undefined) {
  if (!element) throw new Error("Nothing to click");
  await act(async () => {
    element.click();
  });
}

// A level typed into a range input as a keyboard would set it.
async function setLevel(input: HTMLInputElement, level: number) {
  const setValue = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setValue.call(input, String(level));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new FocusEvent("blur"));
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  live = createLiveFeed();
  devices = [officeLight("desk", 60), officeLight("shelf", 80)];
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path === "/api/devices") return devices;
    if (path === "/api/places") return places;
    if (path.startsWith("/api/entities")) return [];
    if (path === "/api/devices/lights") {
      return { on: true, switched: 2, failed: [] };
    }
    throw new Error(`Unexpected ${path}`);
  });
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

describe("a room's Lights tile", () => {
  it("sets every light that is on to the level it is given", async () => {
    await show();
    expect(button("Lights in Office, 2 on · 70%")).toBeDefined();
    const level = container.querySelector<HTMLInputElement>(
      'input[aria-label="Lights in Office brightness"]',
    )!;
    await setLevel(level, 30);
    expect(posted()).toContainEqual({
      place: { kind: "room", id: "office" },
      set: { brightness: 30 },
    });
  });

  it("dims an on light before it reports a brightness", async () => {
    devices = [officeLight("desk", { on: true })];
    await show();
    const level = container.querySelector<HTMLInputElement>(
      'input[aria-label="Lights in Office brightness"]',
    )!;
    await setLevel(level, 30);
    expect(posted()).toEqual([
      { place: { kind: "room", id: "office" }, set: { brightness: 30 } },
    ]);
  });

  it("adds a Lights section for a light combined with a motion sensor", async () => {
    const light = officeLight("desk", 60);
    devices = [
      {
        ...light,
        type: "motion",
        capabilities: [...light.capabilities, motionCapability(false)],
      },
    ];
    await show();
    const lights = container.querySelector(
      'section[aria-labelledby="room-lights"]',
    );
    expect(
      lights?.querySelector('button[aria-label="Lights in Office, 60%"]'),
    ).toBeInstanceOf(HTMLButtonElement);
    expect(
      container.querySelector('section[aria-labelledby="room-presence"]'),
    ).not.toBeNull();
  });

  it("offers the colour of a light that is off, but no level, while the only lit light cannot dim", async () => {
    devices = [
      officeLight("desk", { on: true }, plainLight),
      officeLight("shelf", null, withColour),
    ];
    await show();
    expect(
      container.querySelector(
        'input[aria-label="Lights in Office brightness"]',
      ),
    ).toBeNull();
    await click(button("Lights in Office, 1 of 2 on"));
    expect(tabs()).toEqual([]);
    await click(button("Colour", dialog()!));
    await click(button("Blue", dialog()!));
    expect(posted()).toEqual([
      {
        place: { kind: "room", id: "office" },
        set: { hue: 220, saturation: 100 },
      },
    ]);
  });

  it("offers only power while every light can do no more than switch", async () => {
    devices = [
      officeLight("desk", { on: true }, plainLight),
      officeLight("shelf", null, plainLight),
    ];
    await show();
    await click(button("Lights in Office, 1 of 2 on"));
    expect(tabs()).toEqual([]);
    await click(button("Lights in Office", dialog()!));
    expect(posted()).toEqual([
      { place: { kind: "room", id: "office" }, to: "off" },
    ]);
  });

  it("opens a light's controls for all the room's lights, with a power page where they only dim", async () => {
    await show();
    await click(button("Lights in Office, 2 on · 70%"));
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Lights");
    expect(dialog()?.textContent).toContain("Office · 2 on · 70%");
    expect(tabs()).toEqual(["Brightness", "Power"]);

    // The pages not on show draw once the first has painted.
    await act(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => setTimeout(resolve)),
        ),
    );
    await click(button("Power", dialog()!));
    let done!: (result: LightsResult) => void;
    const pending = new Promise<LightsResult>((resolve) => {
      done = resolve;
    });
    vi.mocked(coreJson).mockReturnValueOnce(pending);
    await click(button("Lights in Office", dialog()!));
    expect(dialog()?.textContent).toContain("Office · Off");
    expect(
      button("Lights in Office", dialog()!)?.getAttribute("aria-pressed"),
    ).toBe("false");
    await click(button("Lights in Office", dialog()!));
    await act(async () => done({ on: false, switched: 2, failed: [] }));
    expect(posted()).toEqual([
      { place: { kind: "room", id: "office" }, to: "off" },
      { place: { kind: "room", id: "office" }, to: "on" },
    ]);
  });

  it("sets the room's colour and white from the picker", async () => {
    devices = [officeLight("desk", 60), officeLight("shelf", 80, withColour)];
    await show();
    await click(button("Lights in Office, 2 on · 70%"));
    expect(tabs()).toEqual(["Colour", "Brightness"]);

    const picker = dialog()!.querySelector('[role="tabpanel"]')!;
    await click(button("Colour", picker));
    await click(button("Blue", dialog()!));
    const blue = officeLight(
      "shelf",
      {
        on: true,
        brightness: 80,
        colorMode: "color",
        hue: 220,
        saturation: 65,
      },
      withColour,
    );
    await act(async () =>
      live.publish({ type: "device", id: blue.id, device: blue }),
    );
    expect(
      button("65% saturation", dialog()!)?.getAttribute("aria-pressed"),
    ).toBe("true");

    await click(button("White", dialog()!));
    await click(button(`${new Intl.NumberFormat().format(2000)} K`, dialog()!));
    expect(posted()).toEqual([
      {
        place: { kind: "room", id: "office" },
        set: { hue: 220, saturation: 100 },
      },
      { place: { kind: "room", id: "office" }, set: { colorTemperature: 500 } },
    ]);
  });
});

it("opens from a room's page by its own key, as no device's tile", async () => {
  let opened: OpenDevice | undefined;
  function Opener() {
    opened = useOpenDevice();
    return null;
  }
  await act(async () => {
    root.render(<Opener />);
  });
  const tile = roomLightsTile([tileOf({})], "office")!;
  opened!.openFromRoom(tile);
  expect(opened!.read().key).toBe(roomLightsKey("office"));
});

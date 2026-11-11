// @vitest-environment jsdom
import type { Places } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreError, coreJson } from "../src/core-fetch";
import {
  placeOf,
  SetupGuide,
  SetupLeft,
  someNames,
  type SetupTarget,
} from "../src/setup-guide";
import type { Devices } from "../src/use-devices";

vi.mock("../src/core-fetch", async (original) => ({
  ...(await original<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

// Setting the home up on the dashboard.

const room = (id: string, name: string) => ({ id, name, floorId: null });
const placesWith = (rooms: Places["rooms"]): Places => ({
  home: { name: "Home", timeZone: "Europe/Zurich", temperatureUnit: "celsius" },
  floors: [],
  zones: [],
  rooms,
});
const devicesWith = (places: Places) => ({ places }) as unknown as Devices;
const bern = { latitude: 46.948, longitude: 7.4474 };

const live = createLiveFeed();

let root: Root;
let container: HTMLDivElement;
let open: ReturnType<typeof vi.fn<(target: SetupTarget) => void>>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  open = vi.fn<(target: SetupTarget) => void>();
  vi.mocked(coreJson).mockReset();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function home(coordinates: unknown) {
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path !== "/api/places/home") throw new Error(`Not here: ${path}`);
    if (coordinates instanceof Error) throw coordinates;
    return { name: "Home", timeZone: null, coordinates };
  });
}

async function show(element: ReactElement) {
  await act(async () => root.render(element));
}

const steps = () =>
  [...container.querySelectorAll("li")].map((step) => ({
    text: step.querySelector("span:nth-of-type(2)")?.textContent,
    button: step.querySelector("button")!,
  }));

describe("the setup guide", () => {
  it("welcomes the person and leads with the first step", async () => {
    home(null);
    await show(
      <SetupGuide
        live={live}
        devices={devicesWith(placesWith([]))}
        person="Maya"
        open={open}
      />,
    );

    expect(container.textContent).toContain("Welcome, Maya");
    expect(container.textContent).toContain("Three steps, in any order.");
    expect(container.querySelector("h1")?.textContent).toBe("Set up your home");
    expect(
      steps().map(({ button }) => [button.textContent, button.dataset.variant]),
    ).toEqual([
      ["Set location", "default"],
      ["Add rooms", "glass"],
      ["Add devices", "glass"],
    ]);
  });

  it("welcomes a shared device without a name", async () => {
    home(null);
    await show(
      <SetupGuide
        live={live}
        devices={devicesWith(placesWith([]))}
        person={null}
        open={open}
      />,
    );

    expect(container.textContent).toContain("Welcome");
    expect(container.textContent).not.toContain("Welcome,");
  });

  it("says what a step done holds, and moves on to the next", async () => {
    home(bern);
    await show(
      <SetupGuide
        live={live}
        devices={devicesWith(
          placesWith([room("k", "Kitchen"), room("o", "Office")]),
        )}
        person="Maya"
        open={open}
      />,
    );

    expect(steps().map(({ text }) => text)).toEqual([
      "Set where the home is, done46.95° N, 7.45° E",
      "Add your rooms, doneKitchen and Office",
      "Add lights, switches and remotesSet each to pairing mode, as its instructions say",
    ]);
    const [location, rooms, devices] = steps().map(({ button }) => button);
    expect(rooms!.getAttribute("aria-label")).toBe("Add more rooms");
    expect(devices!.dataset.variant).toBe("default");
    expect(location!.getAttribute("aria-label")).toBe(
      "Change where the home is",
    );
  });

  it("leaves the location out while the core does not say, and counts what is left", async () => {
    home(new CoreError(403, "forbidden"));
    await show(
      <SetupGuide
        live={live}
        devices={devicesWith(placesWith([]))}
        person={null}
        open={open}
      />,
    );

    expect(steps()).toHaveLength(2);
    expect(container.textContent).toContain("Two steps, in any order.");
  });

  it("opens each step in Settings", async () => {
    home(null);
    await show(
      <SetupGuide
        live={live}
        devices={devicesWith(placesWith([]))}
        person="Maya"
        open={open}
      />,
    );

    for (const { button } of steps()) act(() => button.click());

    expect(open.mock.calls).toEqual([
      ["household"],
      ["add-room"],
      ["add-devices"],
    ]);
  });
});

describe("the steps left", () => {
  it("ignores an older location response after a refresh", async () => {
    let resolve!: (home: unknown) => void;
    vi.mocked(coreJson).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const guide = (
      <SetupLeft
        live={live}
        devices={devicesWith(placesWith([room("k", "Kitchen")]))}
        open={open}
      />
    );
    await show(guide);
    home(bern);
    await act(async () => live.refresh());
    await act(async () => resolve({ coordinates: null }));
    expect(container.innerHTML).toBe("");
  });

  it("retries an unavailable location and hides it if access is later refused", async () => {
    home(new Error("offline"));
    await show(
      <SetupLeft
        live={live}
        devices={devicesWith(placesWith([room("k", "Kitchen")]))}
        open={open}
      />,
    );
    expect(container.innerHTML).toBe("");
    home(null);
    await act(async () => live.refresh());
    expect(container.textContent).toContain("Set location");
    home(new CoreError(403, "forbidden"));
    await act(async () => live.refresh());
    expect(container.innerHTML).toBe("");
  });

  it("stay above the tiles until they are done", async () => {
    home(null);
    await show(
      <SetupLeft
        live={live}
        devices={devicesWith(placesWith([room("k", "Kitchen")]))}
        open={open}
      />,
    );

    expect(container.querySelector("h2")?.textContent).toBe(
      "Finish setting up",
    );
    expect(steps().map(({ button }) => button.textContent)).toEqual([
      "Set location",
    ]);
  });

  it("updates when the home is set up elsewhere and after reconnecting", async () => {
    home(null);
    await show(
      <SetupLeft
        live={live}
        devices={devicesWith(placesWith([room("k", "Kitchen")]))}
        open={open}
      />,
    );
    expect(container.textContent).toContain("Set location");
    home(bern);
    await act(async () =>
      live.publish({
        type: "places",
        places: placesWith([room("k", "Kitchen")]),
      }),
    );
    expect(container.innerHTML).toBe("");
    home(null);
    await act(async () => live.refresh());
    expect(container.textContent).toContain("Set location");
  });

  it("go once every step is done", async () => {
    home(bern);
    await show(
      <SetupLeft
        live={live}
        devices={devicesWith(placesWith([room("k", "Kitchen")]))}
        open={open}
      />,
    );

    expect(container.innerHTML).toBe("");
  });
});

describe("words", () => {
  it("name up to three rooms, then how many more", () => {
    expect(someNames(["Kitchen"])).toBe("Kitchen");
    expect(someNames(["Kitchen", "Office", "Hall"])).toBe(
      "Kitchen, Office and Hall",
    );
    expect(someNames(["Kitchen", "Office", "Hall", "Bath", "Attic"])).toBe(
      "Kitchen, Office, Hall and 2 more",
    );
  });

  it("write coordinates as a place is written", () => {
    expect(placeOf({ latitude: -33.8688, longitude: -151.2093 })).toBe(
      "33.87° S, 151.21° W",
    );
  });
});

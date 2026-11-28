// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreError, coreJson } from "../src/core-fetch";
import { HouseholdSection } from "../src/settings-household";
import { problemLines } from "./problem-lines";

// Settings → Household: anyone sets where the home is, with a suggestion that
// asks the internet only when pressed. And Settings → Apps: each app's catalog
// of what it brings.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const zurich = {
  latitude: 47.3769,
  longitude: 8.5417,
  elevation: 408,
  timeZone: "Europe/Zurich",
};

// The home in Zurich, as the core answers.
const zurichHome = {
  name: "Lake house",
  timeZone: "Europe/Zurich",
  coordinates: { latitude: 47.3769, longitude: 8.5417, elevation: 408 },
  temperatureUnit: "celsius",
  hourCycle: "24h",
};
type Home = Omit<typeof zurichHome, "timeZone" | "coordinates"> & {
  timeZone: string | null;
  coordinates: {
    latitude: number;
    longitude: number;
    elevation: number | null;
  } | null;
};

let root: Root;
let container: HTMLDivElement;
let saved: Partial<Home>[];
let storedHome: Home;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The switch measures itself.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  saved = [];
  storedHome = { ...zurichHome, timeZone: null, coordinates: null };
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
    switch (path) {
      case "/api/places":
        return {
          home: {
            name: "Lake house",
            timeZone: "UTC",
            temperatureUnit: "celsius",
            hourCycle: "24h",
          },
          floors: [],
          rooms: [],
          zones: [],
        };
      case "/api/places/home":
        return storedHome;
      case "/api/places/home/suggest-location":
        return { ...zurich, place: "Zurich, Switzerland" };
      case "/api/places/home/update": {
        const body = init.json as Partial<Home>;
        if (body.timeZone === "Mars") {
          throw new CoreError(400, "invalid_request");
        }
        saved.push(body);
        storedHome = { ...storedHome, ...body };
        return storedHome;
      }
      default:
        throw new Error(`Unexpected request: ${path}`);
    }
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const input = (name: string) =>
  [...container.querySelectorAll("label")]
    .find((label) => label.textContent === name)!
    .parentElement!.querySelector("input")!;
const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (each) => each.textContent === name,
  )!;
const hours = () =>
  container.querySelector<HTMLButtonElement>('[role="switch"]')!;

// Types into a field the way React hears it.
async function type(field: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Settings → Household", () => {
  it("lets anyone fill the location from the suggestion and save it", async () => {
    await act(async () => root.render(<HouseholdSection />));
    expect(input("Name").value).toBe("Lake house");
    expect(input("Latitude").value).toBe("");
    expect(vi.mocked(coreJson).mock.calls.map(([path]) => path)).not.toContain(
      "/api/places/home/suggest-location",
    );

    await act(async () => button("Suggest from this network").click());
    expect(input("Latitude").value).toBe("47.3769");
    expect(input("Longitude").value).toBe("8.5417");
    expect(input("Elevation").value).toBe("408");
    expect(input("Time zone").value).toBe("Europe/Zurich");
    expect(container.textContent).toContain(
      "Near Zurich, Switzerland. Check it, then save.",
    );
    expect(saved).toEqual([]);

    await act(async () => button("Save").click());
    expect(saved).toEqual([
      {
        timeZone: "Europe/Zurich",
        coordinates: { latitude: 47.3769, longitude: 8.5417, elevation: 408 },
      },
    ]);
    expect(container.textContent).toContain("Saved.");
  });

  it("offers manual entry when it can't suggest a location", async () => {
    await act(async () => root.render(<HouseholdSection />));
    vi.mocked(coreJson).mockRejectedValueOnce(
      new CoreError(502, "location_unavailable"),
    );

    await act(async () => button("Suggest from this network").click());
    expect(problemLines(container.querySelector("[role=alert]"))).toEqual([
      "Couldn't find where the home is",
      "The location services didn't answer. Enter the location yourself, or try again.",
    ]);
    expect(button("Suggest from this network").disabled).toBe(false);
  });

  it("keeps the elevation of the same place when the suggestion has none", async () => {
    vi.mocked(coreJson).mockImplementationOnce(async () => zurichHome);
    await act(async () => root.render(<HouseholdSection />));
    const suggestion = (at: object) =>
      vi
        .mocked(coreJson)
        .mockImplementationOnce(async () => ({ ...at, place: null }));

    suggestion({ ...zurich, elevation: null });
    await act(async () => button("Suggest from this network").click());
    expect(input("Elevation").value).toBe("408");

    suggestion({ ...zurich, latitude: 46.948, elevation: null });
    await act(async () => button("Suggest from this network").click());
    expect(input("Latitude").value).toBe("46.948");
    expect(input("Elevation").value).toBe("");
  });

  it("saves the temperature unit the home shows", async () => {
    await act(async () => root.render(<HouseholdSection />));
    const unit = (name: string) =>
      [...container.querySelectorAll<HTMLButtonElement>('[role="radio"]')].find(
        (each) => each.textContent === name,
      )!;
    expect(unit("Celsius").getAttribute("aria-checked")).toBe("true");
    expect(button("Save").disabled).toBe(true);

    await act(async () => unit("Fahrenheit").click());
    expect(button("Save").disabled).toBe(false);
    await act(async () => button("Save").click());

    expect(saved).toEqual([{ temperatureUnit: "fahrenheit" }]);
  });

  it("saves 12-hour time for the whole home", async () => {
    await act(async () => root.render(<HouseholdSection />));
    expect(hours().getAttribute("aria-checked")).toBe("true");
    expect(
      document.getElementById(hours().getAttribute("aria-describedby")!)
        ?.textContent,
    ).toBe(
      "How the home writes times, as 14:30 or 2:30 PM: on every screen and device.",
    );
    expect(button("Save").disabled).toBe(true);

    await act(async () => hours().click());
    expect(hours().getAttribute("aria-checked")).toBe("false");
    expect(button("Save").disabled).toBe(false);
    await act(async () => button("Save").click());

    expect(saved).toEqual([{ hourCycle: "12h" }]);
  });

  it("switches back to 24-hour time and keeps location changes from another device", async () => {
    storedHome = { ...zurichHome, hourCycle: "12h" };
    await act(async () => root.render(<HouseholdSection />));
    expect(hours().getAttribute("aria-checked")).toBe("false");

    storedHome = { ...storedHome, timeZone: null, coordinates: null };
    await act(async () => hours().click());
    await act(async () => button("Save").click());

    expect(saved).toEqual([{ hourCycle: "24h" }]);
    expect(hours().getAttribute("aria-checked")).toBe("true");
    expect(input("Latitude").value).toBe("");
    expect(input("Time zone").value).toBe("");
  });

  it("keeps the clock format changed by another device when saving the name", async () => {
    await act(async () => root.render(<HouseholdSection />));
    storedHome = { ...storedHome, hourCycle: "12h" };
    await type(input("Name"), "Lake cabin");
    await act(async () => button("Save").click());

    expect(saved).toEqual([{ name: "Lake cabin" }]);
    expect(hours().getAttribute("aria-checked")).toBe("false");
    expect(button("Save").disabled).toBe(true);
  });

  it("saves the elevation typed, or none", async () => {
    storedHome = {
      ...zurichHome,
      coordinates: { latitude: 46.948, longitude: 7.4474, elevation: null },
    };
    await act(async () => root.render(<HouseholdSection />));
    expect(input("Elevation").value).toBe("");
    expect(button("Save").disabled).toBe(true);

    await type(input("Elevation"), "9500");
    expect(button("Save").disabled).toBe(true);
    await type(input("Elevation"), "538");
    await act(async () => button("Save").click());
    await type(input("Elevation"), "");
    await act(async () => button("Save").click());

    expect(saved.map((body) => body.coordinates)).toEqual([
      { latitude: 46.948, longitude: 7.4474, elevation: 538 },
      { latitude: 46.948, longitude: 7.4474, elevation: null },
    ]);
  });

  it("takes the coordinates and elevation away when they are emptied, and keeps the time zone", async () => {
    storedHome = zurichHome;
    await act(async () => root.render(<HouseholdSection />));
    expect(input("Latitude").value).toBe("47.3769");
    expect(input("Elevation").value).toBe("408");

    await type(input("Latitude"), "");
    await type(input("Longitude"), "");
    expect(container.textContent).toContain(
      "The elevation goes with the latitude and longitude",
    );
    await act(async () => button("Save").click());

    expect(saved).toEqual([{ coordinates: null }]);
    expect(input("Elevation").value).toBe("");
  });

  it("saves nothing half done, and says what the core refused", async () => {
    await act(async () => root.render(<HouseholdSection />));

    await type(input("Latitude"), "47.3769");
    expect(button("Save").disabled).toBe(true);
    await type(input("Longitude"), "8.5417");
    await type(input("Time zone"), "Mars");
    await act(async () => button("Save").click());

    expect(saved).toEqual([]);
    expect(problemLines(container.querySelector('[role="alert"]'))).toEqual([
      "The changes weren't saved",
      "Sanctum doesn't know that place. Check the numbers and the time zone.",
    ]);
  });

  it("saves no time zone nobody set, and asks for one with coordinates", async () => {
    await act(async () => root.render(<HouseholdSection />));
    expect(input("Time zone").value).toBe("");

    await type(input("Name"), "Lake cabin");
    await act(async () => button("Save").click());
    expect(saved).toEqual([{ name: "Lake cabin" }]);

    await type(input("Latitude"), "47.3769");
    await type(input("Longitude"), "8.5417");
    expect(button("Save").disabled).toBe(true);
    expect(container.textContent).toContain("Add the time zone too");
  });

  it.each(["suggesting", "saving"])(
    "preserves typing while %s",
    async (operation) => {
      await act(async () => root.render(<HouseholdSection />));
      await type(input("Name"), "First name");
      let resolve!: (value: unknown) => void;
      vi.mocked(coreJson).mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );
      await act(async () =>
        button(
          operation === "saving" ? "Save" : "Suggest from this network",
        ).click(),
      );
      await type(input("Name"), "New name");
      await type(input("Latitude"), "40");
      await act(async () =>
        resolve(
          operation === "saving"
            ? { ...storedHome, name: "First name", hourCycle: "12h" }
            : { ...zurich, place: "Zurich" },
        ),
      );

      expect(input("Name").value).toBe("New name");
      expect(input("Latitude").value).toBe("40");
      if (operation === "saving") {
        expect(hours().getAttribute("aria-checked")).toBe("false");
      }
    },
  );

  it.each([
    ["Latitude", "46.948"],
    ["Longitude", "7.4474"],
    ["Elevation", "540"],
    ["Time zone", "Europe/Berlin"],
  ])(
    "keeps the location together when %s changes during a suggestion",
    async (field, value) => {
      storedHome = zurichHome;
      await act(async () => root.render(<HouseholdSection />));
      let resolve!: (value: unknown) => void;
      vi.mocked(coreJson).mockImplementationOnce(
        () =>
          new Promise((done) => {
            resolve = done;
          }),
      );

      await act(async () => button("Suggest from this network").click());
      await type(input(field), value);
      const edited = {
        latitude: Number(input("Latitude").value),
        longitude: Number(input("Longitude").value),
        elevation: Number(input("Elevation").value),
      };
      const timeZone = input("Time zone").value;
      await act(async () =>
        resolve({
          latitude: 39.7392,
          longitude: -104.9903,
          elevation: 1614,
          timeZone: "America/Denver",
          place: "Denver",
        }),
      );
      await act(async () => button("Save").click());

      expect(saved).toEqual([
        field === "Time zone" ? { timeZone } : { coordinates: edited },
      ]);
    },
  );
});

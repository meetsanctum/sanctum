// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreError, coreJson } from "../src/core-fetch";
import { HouseholdSection } from "../src/settings-household";

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
};

let root: Root;
let container: HTMLDivElement;
let saved: unknown[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  saved = [];
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
    switch (path) {
      case "/api/places":
        return {
          home: {
            name: "Lake house",
            timeZone: "UTC",
            temperatureUnit: "celsius",
          },
          floors: [],
          rooms: [],
          zones: [],
        };
      case "/api/places/home":
        return {
          name: "Lake house",
          timeZone: null,
          coordinates: null,
          temperatureUnit: "celsius",
        };
      case "/api/places/home/suggest-location":
        return { ...zurich, place: "Zurich, Switzerland" };
      case "/api/places/home/update": {
        const body = init.json as { name: string; timeZone: string | null };
        if (body.timeZone === "Mars") {
          throw new CoreError(400, "invalid_request");
        }
        saved.push(body);
        return body;
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
        name: "Lake house",
        timeZone: "Europe/Zurich",
        coordinates: { latitude: 47.3769, longitude: 8.5417, elevation: 408 },
        temperatureUnit: "celsius",
      },
    ]);
    expect(container.textContent).toContain("Saved.");
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

  it("saves the temperature unit the home shows, with the rest", async () => {
    await act(async () => root.render(<HouseholdSection />));
    const unit = (name: string) =>
      [
        ...container.querySelectorAll<HTMLInputElement>("input[type=radio]"),
      ].find((each) => each.parentElement?.textContent === name)!;
    expect(unit("Celsius").checked).toBe(true);
    expect(button("Save").disabled).toBe(true);

    await act(async () => unit("Fahrenheit").click());
    expect(button("Save").disabled).toBe(false);
    await act(async () => button("Save").click());

    expect(saved).toEqual([
      {
        name: "Lake house",
        timeZone: null,
        coordinates: null,
        temperatureUnit: "fahrenheit",
      },
    ]);
  });

  it("saves the elevation typed, or none", async () => {
    vi.mocked(coreJson).mockImplementationOnce(async () => ({
      name: "Lake house",
      timeZone: "Europe/Zurich",
      coordinates: { latitude: 46.948, longitude: 7.4474, elevation: null },
    }));
    await act(async () => root.render(<HouseholdSection />));
    expect(input("Elevation").value).toBe("");
    expect(button("Save").disabled).toBe(true);

    await type(input("Elevation"), "9500");
    expect(button("Save").disabled).toBe(true);
    await type(input("Elevation"), "538");
    await act(async () => button("Save").click());
    await type(input("Elevation"), "");
    await act(async () => button("Save").click());

    expect(
      saved.map((body) => (body as typeof zurichHome).coordinates),
    ).toEqual([
      { latitude: 46.948, longitude: 7.4474, elevation: 538 },
      { latitude: 46.948, longitude: 7.4474, elevation: null },
    ]);
  });

  it("takes the coordinates and elevation away when they are emptied, and keeps the time zone", async () => {
    vi.mocked(coreJson).mockImplementationOnce(async () => zurichHome);
    await act(async () => root.render(<HouseholdSection />));
    expect(input("Latitude").value).toBe("47.3769");
    expect(input("Elevation").value).toBe("408");

    await type(input("Latitude"), "");
    await type(input("Longitude"), "");
    expect(container.textContent).toContain(
      "The elevation goes with the latitude and longitude",
    );
    await act(async () => button("Save").click());

    expect(saved).toEqual([
      {
        name: "Lake house",
        timeZone: "Europe/Zurich",
        coordinates: null,
        temperatureUnit: "celsius",
      },
    ]);
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
    expect(container.textContent).toContain(
      "does not know that place. Check the numbers and the time zone.",
    );
  });

  it("saves no time zone nobody set, and asks for one with coordinates", async () => {
    await act(async () => root.render(<HouseholdSection />));
    expect(input("Time zone").value).toBe("");

    await type(input("Name"), "Lake cabin");
    await act(async () => button("Save").click());
    expect(saved).toEqual([
      {
        name: "Lake cabin",
        timeZone: null,
        coordinates: null,
        temperatureUnit: "celsius",
      },
    ]);

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
            ? { name: "First name", timeZone: null, coordinates: null }
            : { ...zurich, place: "Zurich" },
        ),
      );

      expect(input("Name").value).toBe("New name");
      expect(input("Latitude").value).toBe("40");
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
      vi.mocked(coreJson).mockImplementationOnce(async () => zurichHome);
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
        expect.objectContaining({ coordinates: edited, timeZone }),
      ]);
    },
  );
});

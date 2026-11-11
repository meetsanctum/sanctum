// @vitest-environment jsdom
import type {
  AppInfo,
  AppSettings,
  EntityInfo,
  Places,
} from "@meetsanctum/app-sdk";
import type { Me } from "@meetsanctum/auth-protocol";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreError, coreJson } from "../src/core-fetch";
import { SettingsPage } from "../src/settings";
import { unknownHome } from "./home-fixtures";

// Settings → Apps → the app: every app opens its own page, with its
// preferences as a form generated from its settings schema, which every
// client changes. The rest of the page is in app-settings.test.tsx.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const admin: Me = {
  client: {
    id: "macbook",
    name: "Maya's MacBook",
    kind: "personal",
    platform: "macos",
    personId: "maya",
    createdAt: "2026-10-26T12:00:00Z",
    lastSeenAt: null,
    connectedSince: null,
    current: true,
  },
  person: {
    id: "maya",
    name: "Maya",
    avatar: null,
    colour: "#c5cdac",
  },
};
const tablet: Me = {
  client: { ...admin.client, id: "tablet", kind: "shared", personId: null },
  person: null,
};

const weather: AppInfo = {
  id: "sanctum.weather",
  name: "Weather",
  version: "0.1.0",
  icon: { glyph: "cloud-sun", color: "sky" },
  pages: ["main"],
  permissions: [],
  requests: [],
  state: "running",
  settings: {
    type: "object",
    properties: {
      temperatureUnit: {
        type: "string",
        title: "Temperature unit",
        enum: ["celsius", "fahrenheit"],
        options: { celsius: "Celsius", fahrenheit: "Fahrenheit" },
        default: "celsius",
      },
      feelsLike: { type: "boolean", title: "Feels like", default: false },
      days: {
        type: "integer",
        title: "Days",
        description: "How many days the page shows",
        minimum: 1,
        maximum: 14,
        default: 7,
      },
    },
  },
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
};
const zigbee: AppInfo = {
  ...weather,
  id: "sanctum.zigbee",
  name: "Zigbee",
  version: "0.2.0",
  settings: null,
};
const moods: AppInfo = {
  ...weather,
  id: "sanctum.moods",
  name: "Moods",
  settings: null,
  provides: {
    entities: [{ id: "moods.mood", title: "Mood" }],
    widgets: [],
    roomSections: [],
    devicePages: [],
  },
};

const places: Places = {
  home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
  floors: [],
  rooms: [
    { id: "office", name: "Office", floorId: null },
    { id: "kitchen", name: "Kitchen", floorId: null },
  ],
  zones: [{ id: "downstairs", name: "Downstairs", roomIds: ["kitchen"] }],
};

let root: Root;
let container: HTMLDivElement;
let stored: AppSettings;
let updates: unknown[];
let opened: [string, unknown][];
let entities: EntityInfo[];
const live = createLiveFeed();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  stored = { temperatureUnit: "celsius", feelsLike: false, days: 7 };
  updates = [];
  opened = [];
  entities = [];
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
    switch (path) {
      case "/api/apps/sanctum.weather/settings":
        return stored;
      case "/api/apps/sanctum.weather/settings/update": {
        const changes = init.json as Record<string, unknown>;
        updates.push(changes);
        if (changes.days === 30) throw new CoreError(400, "invalid_request");
        stored = { ...stored, ...changes } as AppSettings;
        if (changes.days === null) stored.days = 7;
        return stored;
      }
      case "/api/entities":
        return entities;
      case "/api/devices":
        return [];
      case "/api/places":
        return places;
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

async function show(me: Me, page = "app", app = weather.id) {
  await act(async () =>
    root.render(
      <SettingsPage
        page={page}
        params={{ id: app }}
        open={(next, params) => opened.push([next, params])}
        back={() => opened.push(["back", {}])}
        apps={[weather, zigbee, moods]}
        me={me}
        core={{ state: "online", version: "1.2.3" } as never}
        live={live}
        devices={{ devices: [], places: undefined }}
        home={unknownHome}
        onUpdating={() => undefined}
      />,
    ),
  );
}

const radio = (name: string) =>
  [...container.querySelectorAll<HTMLLabelElement>("fieldset label")]
    .find((label) => label.textContent === name)!
    .querySelector("input")!;
const field = (name: string) =>
  [...container.querySelectorAll("label")]
    .find((label) => label.textContent === name)!
    .parentElement!.querySelector("input")!;

const leave = (input: HTMLInputElement) =>
  input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));

async function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("Settings → Apps", () => {
  it("opens each app's own page", async () => {
    await show(admin, "main");
    const zigbeeRow = [
      ...container.querySelectorAll<HTMLButtonElement>(
        '[aria-labelledby="settings-apps"] button',
      ),
    ].find((button) => button.textContent?.startsWith("Zigbee"))!;

    await act(async () => zigbeeRow.click());

    expect(opened).toEqual([["app", { id: "sanctum.zigbee" }]]);
  });
});

describe("Settings → Apps → the app", () => {
  it("shows the app, and no preferences for one without settings", async () => {
    await show(admin, "app", zigbee.id);

    expect(container.querySelector("h1")?.textContent).toBe("Zigbee settings");
    expect(container.textContent).toContain("Version 0.2.0");
    expect(container.textContent).not.toContain("Preferences");
  });

  it("lets someone choose, and saves the choice at once", async () => {
    await show(admin);
    expect(radio("Celsius").checked).toBe(true);

    await act(async () => radio("Fahrenheit").click());

    expect(updates).toEqual([{ temperatureUnit: "fahrenheit" }]);
    expect(radio("Fahrenheit").checked).toBe(true);
  });

  it("saves a switch at once, and a number once it is left", async () => {
    await show(admin);

    await act(async () =>
      container.querySelector<HTMLButtonElement>('[role="switch"]')!.click(),
    );
    await type(field("Days"), "3");
    expect(updates).toEqual([{ feelsLike: true }]);
    await act(async () => leave(field("Days")));

    expect(updates).toEqual([{ feelsLike: true }, { days: 3 }]);
    expect(container.textContent).toContain("How many days the page shows");
  });

  it("gives back the default when a number is cleared", async () => {
    stored.days = 3;
    await show(admin);

    await type(field("Days"), "");
    await act(async () => leave(field("Days")));

    expect(updates).toEqual([{ days: null }]);
    expect(field("Days").value).toBe("7");
  });

  it("shows the default again when clearing a number already at its default", async () => {
    await show(admin);
    await type(field("Days"), "");
    await act(async () => leave(field("Days")));
    expect(updates).toEqual([{ days: null }]);
    expect(field("Days").value).toBe("7");
  });

  it("does not replace a live value with an older save response", async () => {
    await show(admin);
    let resolve!: (value: AppSettings) => void;
    vi.mocked(coreJson).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => radio("Fahrenheit").click());
    await act(async () =>
      live.publish({
        type: "settings",
        app: weather.id,
        settings: stored,
      }),
    );
    await act(async () =>
      resolve({ ...stored, temperatureUnit: "fahrenheit" }),
    );
    expect(radio("Celsius").checked).toBe(true);
  });

  it("finishes queued edits after leaving the page", async () => {
    await show(admin);
    let resolve!: (value: AppSettings) => void;
    vi.mocked(coreJson).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => radio("Fahrenheit").click());
    await act(async () => radio("Celsius").click());
    await show(admin, "main");
    await act(async () =>
      resolve({ ...stored, temperatureUnit: "fahrenheit" }),
    );
    expect(updates).toEqual([{ temperatureUnit: "celsius" }]);
  });

  it("puts back what the core refused, and says so", async () => {
    await show(admin);

    await type(field("Days"), "30");
    await act(async () => leave(field("Days")));

    expect(field("Days").value).toBe("7");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Days can’t be that. Check it and try again.",
    );
  });

  it("follows a change made on another client", async () => {
    await show(admin);

    await act(async () =>
      live.publish({
        type: "settings",
        app: weather.id,
        settings: { ...stored, temperatureUnit: "fahrenheit" },
      }),
    );

    expect(radio("Fahrenheit").checked).toBe(true);
  });

  it("keeps live changes when an older snapshot finishes loading", async () => {
    let resolve!: (value: AppSettings) => void;
    vi.mocked(coreJson).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await show(admin);
    await act(async () =>
      live.publish({
        type: "settings",
        app: weather.id,
        settings: { ...stored, temperatureUnit: "fahrenheit" },
      }),
    );
    await act(async () => resolve(stored));
    expect(radio("Fahrenheit").checked).toBe(true);
  });

  it("preserves a live change when a pending edit is refused", async () => {
    await show(admin);
    let reject!: (error: Error) => void;
    vi.mocked(coreJson).mockImplementationOnce(
      () =>
        new Promise((_done, fail) => {
          reject = fail;
        }),
    );
    await type(field("Days"), "30");
    await act(async () => leave(field("Days")));
    await act(async () =>
      live.publish({
        type: "settings",
        app: weather.id,
        settings: { ...stored, temperatureUnit: "fahrenheit" },
      }),
    );
    await act(async () => reject(new CoreError(400, "invalid_request")));
    expect(radio("Fahrenheit").checked).toBe(true);
    expect(field("Days").value).toBe("7");
  });

  it("saves quick successive choices in order while showing the latest choice", async () => {
    await show(admin);
    let resolve!: (value: AppSettings) => void;
    vi.mocked(coreJson).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await act(async () => radio("Fahrenheit").click());
    await act(async () => radio("Celsius").click());
    expect(radio("Celsius").checked).toBe(true);
    // The second write waits, so the core cannot apply these out of order.
    expect(updates).toEqual([]);

    await act(async () =>
      resolve({ ...stored, temperatureUnit: "fahrenheit" }),
    );
    expect(updates).toEqual([{ temperatureUnit: "celsius" }]);
    expect(radio("Celsius").checked).toBe(true);
  });

  it("lets a shared client change them too", async () => {
    await show(tablet);

    expect(
      container.querySelectorAll("input, [role='switch']").length,
    ).toBeGreaterThan(0);
    expect(container.textContent).not.toContain("Admins change these");
  });
});

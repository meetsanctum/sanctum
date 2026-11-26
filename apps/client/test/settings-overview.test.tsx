// @vitest-environment jsdom
import type { AppInfo, DeviceInfo, Places } from "@meetsanctum/app-sdk";
import type { ClientInfo, Me } from "@meetsanctum/auth-protocol";
import { createLiveFeed, type PageParams } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { SettingsPage } from "../src/settings";
import { unknownHome } from "./home-fixtures";
import { light, office, zigbee } from "./settings-devices-fixtures";

// Settings' first page: a row for each area, which says how it stands in a
// few words and opens the area's page, which leads with Back to Settings.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const maya: Me = {
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
    drawing: { reduceEffects: false, reduceMotion: false },
    reduceEffects: "off",
    reduceMotion: "off",
    drawingRevision: 0,
    drawn: null,
  },
  person: { id: "maya", name: "Maya", avatar: null, colour: "#c5cdac" },
};
const tablet: ClientInfo = {
  ...maya.client,
  id: "tablet",
  name: "Kitchen tablet",
  kind: "shared",
  personId: null,
  current: false,
  drawing: { reduceEffects: false, reduceMotion: false },
  reduceEffects: "off",
  reduceMotion: "off",
  drawingRevision: 0,
  drawn: null,
};

const home: Places = {
  home: {
    name: "Office",
    timeZone: "Europe/Zurich",
    temperatureUnit: "celsius",
    hourCycle: "24h",
  },
  floors: [{ id: "ground", name: "Ground floor", level: 0 }],
  rooms: [
    { ...office, floorId: "ground" },
    { id: "hall", name: "Hall", floorId: "ground" },
  ],
  zones: [],
};
const weather: AppInfo = {
  ...zigbee,
  id: "sanctum.weather",
  name: "Weather",
  waiting: { id: "u1", version: "0.5.0", build: "b", needs: [] } as never,
};

let container: HTMLDivElement;
let root: Root;
let clients: ClientInfo[];
let agents: unknown[];
let models: unknown[];
let opened: [string, PageParams | undefined][];
let wentBack: number;
const live = createLiveFeed();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  clients = [maya.client, tablet, { ...tablet, id: "phone", name: "Phone" }];
  agents = [{ id: "codex" }, { id: "claude" }];
  models = [
    {
      id: "mac",
      kind: "computer",
      model: "qwen3:8b",
      modelName: "Qwen3 8B",
      computer: "Office Mac",
      inUse: true,
      tokens: { today: 0, month: 0 },
    },
  ];
  opened = [];
  wentBack = 0;
  vi.mocked(coreJson).mockImplementation(async (path: string) => {
    if (path === "/api/auth/clients") return clients as never;
    if (path === "/api/auth/agents") return agents as never;
    if (path === "/api/models") return { sources: models } as never;
    throw new Error(`unexpected ${path}`);
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

async function show(
  props: {
    page?: string;
    backTo?: string;
    apps?: AppInfo[];
    devices?: DeviceInfo[];
    places?: Places;
  } = {},
) {
  await act(async () =>
    root.render(
      <SettingsPage
        page={props.page ?? "main"}
        params={{}}
        open={(page, params) => opened.push([page, params])}
        back={() => wentBack++}
        backTo={props.backTo}
        apps={props.apps ?? []}
        me={maya}
        core={{ state: "online", version: "1.2.3" } as never}
        live={live}
        devices={{ devices: props.devices ?? [], places: props.places }}
        home={unknownHome}
        onUpdating={() => undefined}
        status={{ problems: [], host: null } as never}
      />,
    ),
  );
}

const rows = () =>
  [
    ...container.querySelectorAll<HTMLButtonElement>(
      'nav[aria-label="Settings"] button',
    ),
  ].map((button) => button.textContent);

const row = (area: string) =>
  [
    ...container.querySelectorAll<HTMLButtonElement>(
      'nav[aria-label="Settings"] button',
    ),
  ].find((button) => button.textContent?.startsWith(area))!;

describe("Settings' first page", () => {
  it("has a row for each area, saying how it stands", async () => {
    await show({
      apps: [zigbee, weather],
      devices: [
        light("lamp", "Office Light", { roomId: "office" }),
        light("sensor", "Hall Sensor", { roomId: "hall", battery: 5 }),
      ],
      places: home,
    });

    expect(rows()).toEqual([
      "HouseholdOffice · Zurich · Celsius",
      "Rooms and Floors2 rooms on 1 floor",
      "Devices2 devices",
      "Maintenance1 battery",
      "ActivityWho did what in the home",
      "Apps2 apps · 1 update waiting",
      "AI Agents2 agents",
      "AI ModelsQwen3 8B on Office Mac",
      "ClientsThis device and 2 others",
      "SystemCan't check right now",
    ]);
    expect(row("System").getAttribute("aria-label")).toBe(
      "System: can't check right now",
    );
  });

  it("says what a new home doesn't have yet", async () => {
    clients = [maya.client];
    agents = [];
    models = [];
    await show({
      apps: [zigbee],
      places: { ...home, floors: [], rooms: [] },
    });

    expect(rows()).toEqual([
      "HouseholdOffice · Zurich · Celsius",
      "Rooms and FloorsNo rooms yet",
      "DevicesNone yet",
      "MaintenanceNothing to do",
      "ActivityWho did what in the home",
      "Apps1 app",
      "AI AgentsNone yet",
      "AI ModelsNone yet",
      "ClientsThis device",
      "SystemCan't check right now",
    ]);
  });

  it("counts rooms and floors without putting unassigned rooms on a floor", async () => {
    await show({ places: { ...home, rooms: [office, home.rooms[1]!] } });
    expect(row("Rooms and Floors").textContent).toBe(
      "Rooms and Floors2 rooms · 1 floor",
    );

    await show({ places: { ...home, rooms: [] } });
    expect(row("Rooms and Floors").textContent).toBe(
      "Rooms and FloorsNo rooms yet · 1 floor",
    );
  });

  it("updates the client count on the shell's next refresh", async () => {
    await show();
    expect(row("Clients").textContent).toBe("ClientsThis device and 2 others");

    clients = [maya.client, tablet];
    await act(async () => live.refresh());

    expect(row("Clients").textContent).toBe("ClientsThis device and 1 other");
  });

  it("opens each area's page", async () => {
    await show({ places: home });

    for (const area of [
      "Household",
      "Rooms and Floors",
      "Devices",
      "Maintenance",
      "Activity",
      "Apps",
      "Clients",
      "System",
    ]) {
      await act(async () => row(area).click());
    }

    expect(opened.map(([page]) => page)).toEqual([
      "household",
      "rooms",
      "devices",
      "maintenance",
      "activity",
      "apps",
      "clients",
      "system",
    ]);
  });
});

describe("an area's page", () => {
  it("leads with Back, named for the page under it, and has its title once", async () => {
    await show({ page: "clients", backTo: "Settings" });

    const back = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Back to Settings"]',
    )!;
    expect(back.textContent).toBe("Settings");
    expect(
      [...container.querySelectorAll("h1, h2")].map((each) => each.textContent),
    ).toEqual(["Clients"]);
    expect(container.textContent).toContain("Add a shared device");

    await act(async () => back.click());
    expect(wentBack).toBe(1);
  });

  it("closes with Done when it was opened from elsewhere", async () => {
    await show({ page: "maintenance" });
    expect(container.querySelector('button[aria-label^="Back to"]')).toBeNull();
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Done",
      ),
    ).toBe(true);

    await show({ page: "maintenance", backTo: "Settings" });
    expect(
      [...container.querySelectorAll("button")].some(
        (button) => button.textContent === "Done",
      ),
    ).toBe(false);
  });
});

// @vitest-environment jsdom
import type {
  AppInfo,
  EntityInfo,
  StaticManifest,
  WorkflowInfo,
} from "@meetsanctum/app-sdk";
import {
  createLiveFeed,
  HomeTimeZoneProvider,
  TemperatureUnitProvider,
} from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AppPage } from "../src/app-settings";
import { CoreError, coreJson } from "../src/core-fetch";
import { light, remote, zigbee } from "./settings-devices-fixtures";

// An app's settings page: its state, its permissions in Sanctum's words with
// a switch each, and what it adds, drawn from its manifest's samples with live
// counts.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const moods: AppInfo = {
  id: "sanctum.moods",
  name: "Moods",
  version: "0.8.0",
  icon: { glyph: "sparkles", color: "ember" },
  pages: ["main", "room"],
  permissions: ["places.read", "devices.control:light", "devices.read:button"],
  requests: [
    {
      id: "places.read",
      reason: "To keep moods for each room.",
      needed: true,
      asked: null,
      startsOn: false,
    },
    {
      id: "devices.control:light",
      reason: "To set your lights when a mood runs.",
      needed: true,
      asked: null,
      startsOn: false,
    },
    {
      id: "devices.read:button",
      reason: "So a press of a remote can run the mood you chose.",
      needed: false,
      asked: "when you choose what a remote's press does",
      startsOn: true,
    },
  ],
  state: "running",
  settings: null,
  provides: {
    entities: [{ id: "moods.mood", title: "Mood" }],
    widgets: [],
    roomSections: [],
    devicePages: [{ id: "moods.presses", title: "Presses", kinds: ["button"] }],
  },
};
const weather: AppInfo = {
  ...moods,
  id: "sanctum.weather",
  name: "Weather",
  version: "0.3.0",
  icon: { glyph: "cloud-sun", color: "sky" },
  permissions: ["places.location"],
  requests: [
    {
      id: "places.location",
      reason: "To fetch the forecast and sun times for where you live.",
      needed: true,
      asked: null,
      startsOn: false,
    },
  ],
  provides: {
    entities: [{ id: "weather.forecast", title: "Forecast" }],
    widgets: [
      { id: "weather.card", title: "Weather", size: { columns: 4, rows: 4 } },
    ],
    roomSections: [],
    devicePages: [],
  },
};

// The parts of a manifest the page reads.
const pieces = { triggers: [], conditions: [], steps: [] };
const manifests: Record<string, StaticManifest> = {
  [moods.id]: {
    runtime: { memory: 128, data: 256 },
    summary:
      "Moods for each room, and what remotes and motion do with its lights.",
    driver: null,
    actions: [{ id: "moods.runMood", title: "Run a mood" }],
    provides: {
      ...pieces,
      entities: [{ id: "moods.mood", title: "Mood", standard: false }],
      widgets: [],
      roomSections: [
        {
          id: "moods.room",
          title: "Moods",
          entityType: "moods.mood",
          preview: [
            { icon: "sparkles", name: "Aurora", active: true },
            { icon: "moon", name: "Night", active: false },
          ],
        },
      ],
      steps: [
        {
          id: "moods.runMood",
          words: { sentence: "Run {id}", preview: { id: "Aurora" } },
        },
      ],
    },
  } as unknown as StaticManifest,
  [weather.id]: {
    summary: "The forecast and sun times for where your home is.",
    driver: null,
    actions: [],
    provides: {
      ...pieces,
      entities: [{ id: "weather.forecast", title: "Forecast", standard: true }],
      roomSections: [],
      widgets: [
        {
          id: "weather.card",
          title: "Weather",
          size: { columns: 4, rows: 4 },
          preview: {
            blocks: [
              {
                kind: "headline",
                icon: "cloud-sun",
                value: { temperature: 18 },
              },
              { kind: "line", text: "Partly cloudy" },
            ],
          },
        },
      ],
    },
  } as unknown as StaticManifest,
  [zigbee.id]: {
    summary:
      "Brings your Zigbee lights, plugs, remotes and sensors into your home.",
    driver: { hooks: ["command"] },
    actions: [],
    provides: {
      ...pieces,
      entities: [],
      widgets: [],
      roomSections: [],
    },
  } as unknown as StaticManifest,
};

const mood = (key: string, placeId: string): EntityInfo => ({
  app: moods.id,
  key,
  type: "moods.mood",
  name: key,
  state: { placeId, icon: "sparkles", name: key, order: 0, active: false },
  updatedAt: "2026-11-03T09:00:00Z",
});
const runs = (piece: string): WorkflowInfo =>
  ({
    id: `w-${piece}`,
    name: "Bedside press",
    graph: { nodes: [{ id: "n", kind: "step", app: moods.id, piece }] },
  }) as unknown as WorkflowInfo;

let root: Root;
let container: HTMLDivElement;
let granted: unknown[];
let changed: AppInfo[];
let openedStatus: number;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  granted = [];
  changed = [];
  openedStatus = 0;
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
    const manifest = /^\/api\/apps\/([^/]+)\/manifest$/.exec(path);
    if (manifest) return manifests[decodeURIComponent(manifest[1]!)];
    if (path.startsWith("/api/entities?app=")) {
      return path.endsWith(encodeURIComponent(moods.id))
        ? [
            mood("Aurora", "office"),
            mood("Night", "kitchen"),
            mood("Dim", "office"),
          ]
        : [];
    }
    if (path === "/api/workflows") return [runs("moods.runMood")];
    if (path === `/api/apps/${moods.id}/permissions/update`) {
      const change = init.json as { permission: string; granted: boolean };
      granted.push(change);
      return {
        ...moods,
        permissions: change.granted
          ? [...moods.permissions, change.permission]
          : moods.permissions.filter((id) => id !== change.permission),
      };
    }
    throw new Error(`Unexpected request: ${path}`);
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

async function show(app: AppInfo) {
  await act(async () =>
    root.render(
      <TemperatureUnitProvider unit="celsius">
        <HomeTimeZoneProvider timeZone="Europe/Zurich">
          <AppPage
            app={app}
            apps={[moods, weather, zigbee]}
            devices={[
              light("lamp", "Lamp"),
              remote,
              { ...remote, id: "dimmer" },
            ]}
            rooms={[
              { id: "office", name: "Office", floorId: null },
              { id: "kitchen", name: "Kitchen", floorId: null },
            ]}
            live={createLiveFeed()}
            background="var(--dashboard-mocha)"
            onChanged={(next) => changed.push(next)}
            openStatus={() => (openedStatus += 1)}
            onDone={() => undefined}
          />
        </HomeTimeZoneProvider>
      </TemperatureUnitProvider>,
    ),
  );
}

const text = () => container.textContent ?? "";
const switchFor = (title: string) =>
  container.querySelector<HTMLButtonElement>(
    `[role="switch"][aria-label="${title}"]`,
  )!;
const button = (name: string) =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) => each.textContent === name,
  )!;

describe("an app's settings page", () => {
  it("shows how it's running for one in its own container, before its last buttons", async () => {
    await show({ ...moods, run: { since: "2026-11-06T10:00:00.000Z" } });

    const heading = [...container.querySelectorAll("h2")].find(
      ({ textContent }) => textContent === "How it's running",
    );
    const turnOff = [...container.querySelectorAll("button")].find(
      ({ textContent }) => textContent === "Turn off Moods",
    );
    expect(heading).toBeDefined();
    expect(
      heading!.compareDocumentPosition(turnOff!) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("has nothing to say of how one in the core's process is running", async () => {
    await show(moods);

    expect(container.textContent).not.toContain("How it's running");
  });

  it("says its version, its state and what it does", async () => {
    await show(moods);

    expect(container.querySelector("h1")?.textContent).toBe("Moods settings");
    expect(text()).toContain("Version 0.8.0");
    expect(text()).toContain("Running");
    expect(text()).toContain("Moods for each room");
  });

  it("says first that it is paused, and why", async () => {
    await show({ ...moods, permissions: ["places.read"], state: "paused" });

    expect(text()).toContain("Paused · it needs “Control your lights”");
    expect(text()).toContain(
      "It needs “Control your lights” to work. Turn it back on below to start it again.",
    );
  });

  it("says when it isn't running, and opens Status, where Restart is", async () => {
    await show({ ...moods, state: "stopped" });

    expect(text()).toContain("Moods isn't running");
    await act(async () => button("Open Status").click());
    expect(openedStatus).toBe(1);
  });

  it("names each permission in Sanctum's words, with the app's reason", async () => {
    await show(moods);

    const rows = [
      ...container.querySelectorAll(
        '[aria-labelledby="settings-app-permissions"] li',
      ),
    ].map((row) => row.textContent);
    expect(rows).toEqual([
      "See your roomsTo keep moods for each room.Needed",
      "Control your lightsTo set your lights when a mood runs.Needed",
      "See your remotes' pressesSo a press of a remote can run the mood you chose.",
    ]);
    expect(
      switchFor("See your remotes' presses").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("says, while one is off, when the app asks for it", async () => {
    await show({
      ...moods,
      permissions: ["places.read", "devices.control:light"],
    });

    expect(
      container.querySelector(
        '[aria-labelledby="settings-app-permissions"] li:last-child',
      )?.textContent,
    ).toBe(
      "See your remotes' pressesSo a press of a remote can run the mood you chose. Asked when you choose what a remote's press does.",
    );
  });

  it("switches one the app does without at once, and takes the core's answer", async () => {
    await show(moods);

    await act(async () => switchFor("See your remotes' presses").click());

    expect(granted).toEqual([
      { permission: "devices.read:button", granted: false },
    ]);
    expect(changed.at(-1)?.permissions).not.toContain("devices.read:button");
  });

  it("asks before switching off one the app needs", async () => {
    await show(moods);

    await act(async () => switchFor("Control your lights").click());
    expect(document.body.textContent).toContain(
      "Turn off “Control your lights” for Moods?",
    );
    await act(async () => button("Cancel").click());
    expect(granted).toEqual([]);

    await act(async () => switchFor("Control your lights").click());
    await act(async () => button("Turn off").click());
    expect(granted).toEqual([
      { permission: "devices.control:light", granted: false },
    ]);
  });

  it("says so when the core couldn't take a permission back in time", async () => {
    vi.mocked(coreJson).mockImplementationOnce(async () => {
      throw new CoreError(503, "unavailable");
    });
    await show(moods);
    vi.mocked(coreJson).mockImplementation(async () => {
      throw new CoreError(503, "unavailable");
    });

    await act(async () => switchFor("See your remotes' presses").click());

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Moods still has “See your remotes' presses”: Sanctum couldn't take it back in time. Try again.",
    );
    expect(
      switchFor("See your remotes' presses").getAttribute("aria-checked"),
    ).toBe("true");
  });

  it("previews its room section on Home's background, and says where it is", async () => {
    await show(moods);

    expect(text()).toContain("In 2 rooms, under each room's name");
    const preview = container.querySelector('[role="img"]')!;
    expect(preview.getAttribute("aria-label")).toBe(
      "A preview of Moods' tiles under a room's name: Aurora, which is on and Night",
    );
    expect(preview.textContent).toBe("OfficeAuroraNight");
    expect(preview.className).toContain("home-slice");
  });

  it("counts only existing rooms that contain its tiles", async () => {
    const request = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation(async (path, init) =>
      path.startsWith("/api/entities?app=")
        ? [
            mood("Aurora", "office"),
            mood("Night", "deleted-room"),
            mood("Dim", "downstairs-zone"),
          ]
        : request(path, init),
    );
    await show(moods);

    expect(text()).toContain("In 1 room, under each room's name");
  });

  it("previews its widget from its sample, as Home draws it", async () => {
    await show(weather);

    const preview = container.querySelector('[role="img"]')!;
    expect(preview.textContent).toBe("Weather18°Partly cloudy");
    expect(text()).toContain(
      "On Home once Weather shows it · four cells square",
    );
  });

  it("lists its pieces with sample values, and how many automations use them", async () => {
    await show(moods);

    const pieces = container.querySelector(
      '[aria-labelledby="settings-app-pieces"]',
    )!;
    expect(pieces.textContent).toBe(
      "Workflow piecesWith sample valuesRun AuroraStep · Used by 1 automation",
    );
  });

  it("counts a workflow only for the matching kind of piece", async () => {
    const request = vi.mocked(coreJson).getMockImplementation()!;
    const workflow = runs("moods.runMood");
    vi.mocked(coreJson).mockImplementation(async (path, init) => {
      if (path === `/api/apps/${moods.id}/manifest`) {
        const manifest = manifests[moods.id]!;
        return {
          ...manifest,
          provides: {
            ...manifest.provides,
            conditions: manifest.provides.steps,
          },
        };
      }
      return path === "/api/workflows"
        ? [
            {
              ...workflow,
              graph: {
                ...workflow.graph,
                nodes: workflow.graph.nodes.map((node) => ({
                  ...node,
                  kind: "condition",
                })),
              },
            },
          ]
        : request(path, init);
    });
    await show(moods);

    expect(
      container.querySelector('[aria-labelledby="settings-app-pieces"]')
        ?.textContent,
    ).toContain("Step · Used by no automation yet");
    expect(text()).toContain("Condition · Used by 1 automation");
  });

  it("says which devices' detail its pages are in", async () => {
    await show(moods);

    expect(text()).toContain("PressesIn the detail of your 2 remotes");
  });

  it("says which devices a driver brings", async () => {
    await show(zigbee);

    expect(text()).toContain("3 devicesLights and remotes");
  });

  it("says who reads what it shares", async () => {
    await show(weather);

    expect(text()).toContain("ForecastRead by no other app yet");
  });
});

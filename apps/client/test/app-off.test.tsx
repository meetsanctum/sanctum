// @vitest-environment jsdom
import type { AppInfo, AppRun, WorkflowInfo } from "@meetsanctum/app-sdk";
import {
  createLiveFeed,
  HomeTimeZoneProvider,
  TemperatureUnitProvider,
} from "@meetsanctum/ui-sdk";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activityWords } from "../src/activity/words";
import { AppPage } from "../src/app-settings";
import {
  AppNotice,
  isShown,
  looksRunning,
  stateShort,
  turningOffWords,
} from "../src/app-state";
import { appsNotRunning, needingAttention } from "../src/attention";
import {
  blockedBy,
  blockedLine,
  blockedWords,
} from "../src/automations/blocked";
import { CoreError, coreJson } from "../src/core-fetch";
import { entry } from "./activity-fixtures";
import { remote } from "./settings-devices-fixtures";

// An app someone turned off: what its settings ask first, what it says while
// it's off, and that it leaves what the home shows.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const provides = {
  entities: [],
  widgets: [],
  roomSections: [],
  devicePages: [],
};
const app = (over: Partial<AppInfo> = {}, run?: AppRun): AppInfo =>
  ({
    id: "test.weather",
    name: "Weather",
    version: "0.3.0",
    icon: null,
    pages: [],
    permissions: [],
    requests: [],
    state: "off",
    ...(run ? { run } : {}),
    settings: null,
    provides,
    ...over,
  }) as AppInfo;
const withCard = app({
  provides: {
    ...provides,
    widgets: [{ id: "weather.card", title: "Weather" }],
  },
} as unknown as Partial<AppInfo>);
const withMoods = app({
  name: "Moods",
  provides: {
    ...provides,
    roomSections: [{ id: "moods.room", title: "Moods" }],
  },
} as unknown as Partial<AppInfo>);

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(coreJson).mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.body.replaceChildren();
});

const show = (ui: ReactNode) => act(async () => root.render(ui));
const notice = (shown: AppInfo, deviceCount?: number) =>
  show(
    <AppNotice
      app={shown}
      permissionsAre="settings"
      openStatus={() => undefined}
      openSettings={() => undefined}
      deviceCount={deviceCount}
    />,
  );
// A dialog draws outside the page it opened from.
const button = (name: string) =>
  [...document.querySelectorAll("button")].find(
    (each) =>
      each.getAttribute("aria-label") === name || each.textContent === name,
  );
const press = (name: string) => act(async () => button(name)!.click());

describe("an app that's off", () => {
  it("doesn't look like it runs, and says Off", () => {
    expect(looksRunning(app())).toBe(false);
    expect(stateShort(app())).toBe("Off");
  });

  it("leaves what the home shows, while one that fails stays, saying so", () => {
    expect(isShown(app())).toBe(false);
    expect(isShown(app({ state: "failed" }))).toBe(true);
    expect(isShown(app({ state: "paused" }))).toBe(true);
    expect(isShown(app({ state: "running" }))).toBe(true);
  });

  it("isn't something that needs attention: someone chose it", () => {
    expect(appsNotRunning([app()])).toEqual([]);
  });

  it("doesn't call its devices offline in Needs attention, though another's are", () => {
    const zigbee = app({ id: "sanctum.zigbee", name: "Zigbee" });
    const offline = { ...remote, availability: "offline" as const };
    const room = [{ id: "office", name: "Office", floorId: null }];
    const placed = { ...offline, placeId: "office" };

    expect(
      needingAttention([{ ...placed, driver: "sanctum.zigbee" }], room, [
        zigbee,
      ]),
    ).toEqual([]);
    expect(
      needingAttention([{ ...placed, driver: "sanctum.zigbee" }], room, [
        { ...zigbee, state: "running" },
      ]).map(({ reasons }) => reasons),
    ).toEqual([["offline"]]);
  });

  it("keeps automations from running, saying where to turn it on", () => {
    const blocked = blockedBy(
      {
        id: "w",
        app: "test.weather",
        graph: { nodes: [] },
      } as unknown as WorkflowInfo,
      [app()],
    )!;

    expect(blocked.kind).toBe("off");
    expect(blockedLine(blocked)).toBe("Can't run while Weather is off");
    expect(blockedWords(blocked).detail).toBe(
      "Turn it back on in Weather settings.",
    );
  });

  it.each([
    ["turn-off", "ok", "Turned the app off"],
    ["turn-off", "failed", "Couldn't turn the app off"],
    ["turn-on", "ok", "Turned the app on"],
    ["turn-on", "failed", "Couldn't turn the app on"],
  ] as const)("goes in the activity log (%s, %s)", (action, outcome, title) => {
    const words = activityWords(entry({ action, outcome }), "home");
    expect(words.title).toBe(title);
  });
});

describe("what it asks before turning off", () => {
  it.each<[string, AppInfo, number, string]>([
    [
      "a driver's devices",
      app({ name: "Zigbee" }),
      14,
      "Its 14 devices go offline, and remotes and automations can't use them until you turn it back on. Its data stays.",
    ],
    [
      "a driver's one device",
      app({ name: "Zigbee" }),
      1,
      "Its device goes offline, and remotes and automations can't use it until you turn it back on. Its data stays.",
    ],
    [
      "its card",
      withCard,
      0,
      "Its card leaves Home until you turn it back on. Its data stays.",
    ],
    [
      "what it adds to rooms",
      withMoods,
      0,
      "Its moods leave every room until you turn it back on. Its data stays.",
    ],
    [
      "one that adds nothing",
      app(),
      0,
      "It stops running until you turn it back on. Its data stays.",
    ],
  ])("names %s", (_what, shown, devices, words) => {
    expect(turningOffWords(shown, devices)).toBe(words);
  });
});

describe("its notice", () => {
  it("says it's off and what that means, with Turn on", async () => {
    await notice(withCard);

    expect(host.textContent).toContain("Weather is off");
    expect(host.textContent).toContain(
      "Its card isn't on Home. Its data stays, so turning it on brings everything back.",
    );
    expect(button("Turn on Weather")?.textContent).toBe("Turn on");
  });

  it("names a driver's devices where the page knows them", async () => {
    await notice(app({ name: "Zigbee" }), 14);

    expect(host.textContent).toContain("Its 14 devices are offline.");
  });

  it("says it frees its memory only where it has a container to stop", async () => {
    await notice(app({}, { since: "2026-11-05T14:02:00.000Z" }));

    expect(host.textContent).toContain(
      "It doesn't run, and it uses no memory.",
    );

    await notice(app());

    expect(host.textContent).not.toContain("memory");
  });

  it("turns it on without asking", async () => {
    vi.mocked(coreJson).mockResolvedValue(app({ state: "running" }));
    await notice(app());

    await press("Turn on Weather");

    expect(coreJson).toHaveBeenCalledWith("/api/apps/test.weather/off", {
      method: "POST",
      json: { off: false },
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("offers it again if that fails", async () => {
    vi.mocked(coreJson).mockRejectedValue(new CoreError(500, "No"));
    await notice(app());

    await press("Turn on Weather");

    expect(button("Try again to turn on Weather")?.textContent).toBe(
      "Try again",
    );
  });
});

describe("turning it off in its settings", () => {
  const zigbee = app({
    id: "sanctum.zigbee",
    name: "Zigbee",
    state: "running",
  });
  const page = (shown: AppInfo) => {
    vi.mocked(coreJson).mockImplementation(async (path) => {
      if (path.endsWith("/manifest")) {
        return {
          summary: "",
          driver: null,
          actions: [],
          provides: {
            ...provides,
            triggers: [],
            conditions: [],
            steps: [],
          },
        };
      }
      if (path.startsWith("/api/entities")) return [];
      if (path === "/api/workflows") return [];
      if (path.endsWith("/off")) return shown;
      throw new Error(`Unexpected request: ${path}`);
    });
    return show(
      <TemperatureUnitProvider unit="celsius">
        <HomeTimeZoneProvider timeZone="Europe/Zurich">
          <AppPage
            app={shown}
            apps={[shown]}
            devices={[
              { ...remote, driver: "sanctum.zigbee" },
              { ...remote, id: "dimmer", driver: "sanctum.zigbee" },
            ]}
            rooms={[]}
            live={createLiveFeed()}
            background="var(--dashboard-mocha)"
            onChanged={() => undefined}
            openStatus={() => undefined}
            onDone={() => undefined}
          />
        </HomeTimeZoneProvider>
      </TemperatureUnitProvider>,
    );
  };
  const offCalls = () =>
    vi.mocked(coreJson).mock.calls.filter(([path]) => path.endsWith("/off"));

  beforeEach(() => vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true));
  afterEach(() => vi.unstubAllGlobals());

  it("asks first, naming what goes, with Cancel focused", async () => {
    await page(zigbee);

    await press("Turn off Zigbee");

    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.textContent).toContain("Turn off Zigbee?");
    expect(dialog.textContent).toContain(
      "Its 2 devices go offline, and remotes and automations can't use them",
    );
    expect(document.activeElement?.textContent).toBe("Cancel");
    expect(offCalls()).toEqual([]);
  });

  it("does nothing on Cancel", async () => {
    await page(zigbee);
    await press("Turn off Zigbee");

    await press("Cancel");

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(offCalls()).toEqual([]);
  });

  it("turns it off once asked", async () => {
    await page(zigbee);
    await press("Turn off Zigbee");

    await press("Turn off");

    expect(offCalls()).toEqual([
      ["/api/apps/sanctum.zigbee/off", { method: "POST", json: { off: true } }],
    ]);
  });

  it("says so if it couldn't", async () => {
    await page(zigbee);
    await press("Turn off Zigbee");
    vi.mocked(coreJson).mockRejectedValue(new CoreError(500, "No"));

    await press("Turn off");

    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      "Zigbee couldn't be turned off. Try again.",
    );
  });

  it("brings its notice into view once it's off, which starts the page", async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    await page(zigbee);
    expect(scrolled).not.toHaveBeenCalled();

    await page({ ...zigbee, state: "off" });

    expect(scrolled).toHaveBeenCalledTimes(1);
    Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  });

  it("has no Turn off for a system app, which the core would refuse", async () => {
    await page({ ...zigbee, alwaysOn: true });

    expect(button("Turn off Zigbee")).toBeUndefined();
  });

  it("has no Turn off while it's off, and its notice instead", async () => {
    await page({ ...zigbee, state: "off" });

    expect(button("Turn off Zigbee")).toBeUndefined();
    expect(button("Turn on Zigbee")).toBeDefined();
    expect(document.body.textContent).toContain("Its 2 devices are offline.");
  });
});

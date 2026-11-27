// @vitest-environment jsdom
import { homeClock } from "@meetsanctum/app-sdk/clock";
import type { ClientInfo, PersonInfo } from "@meetsanctum/auth-protocol";
import {
  createLiveFeed,
  HomeTimeZoneProvider,
  TemperatureUnitProvider,
} from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreError, coreJson } from "../src/core-fetch";
import type { CoreStatus } from "../src/core-status";
import { clientDetail } from "../src/settings-clients";
import { useGoing, type Going } from "../src/power-notice";
import { SystemPage } from "../src/settings-status";
import type { SpacePlan } from "../src/settings-status-space";
import type { SystemStatus } from "../src/system-status";
import type { HostPoint } from "../src/system-status-day";
import type { UpdateStatus } from "../src/system-update";
import { piStatus, statusApps } from "./system-status-fixtures";

// The device's own zone, which the expectations here are worked out in.
const clock = homeClock();

// What Status lets someone do: Restart and Shut down, asked first; Free up
// space, saying what goes and what stays; the last 24 hours; and the clients
// connected now.

vi.mock("../src/core-fetch", async (original) => ({
  ...(await original<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const plan: SpacePlan = {
  bytes: 1_300_000_000,
  images: [{ service: "zigbee2mqtt", version: "2.14.1" }],
  devBuilds: 11,
  keeps: {
    running: "dev-ed4f70b",
    before: "dev-b7df8ce",
    newest: "dev-1040943",
  },
};

const builds = [
  { version: "dev-1040943" },
  { version: "dev-ed4f70b" },
  { version: "dev-b7df8ce" },
  { version: "dev-older" },
];

const client = (changes: Partial<ClientInfo>): ClientInfo => ({
  id: "mac",
  name: "Alex's Mac",
  kind: "personal",
  platform: "macos",
  personId: "alex",
  createdAt: "2026-10-26T12:00:00Z",
  lastSeenAt: null,
  connectedSince: null,
  current: false,
  reduceEffects: false,
  reduceMotion: false,
  ...changes,
});

const today = (time: string) => {
  const at = new Date();
  const [hours, minutes] = time.split(":").map(Number);
  at.setHours(hours!, minutes, 0, 0);
  return at.toISOString();
};

let root: Root;
let container: HTMLDivElement;
let answers: Record<string, () => Promise<unknown>>;
let status: SystemStatus;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // The charts measure their width, and draw nothing until it is known.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(480);
  const now = Date.now();
  status = piStatus({ checkedAt: new Date(now).toISOString() });
  answers = {
    "/api/system/status": async () => status,
    "/api/system/history": async () => ({
      points: [0, 1, 2].map((index): HostPoint => ({
        at: new Date(
          Math.floor(now / 300_000) * 300_000 - (3 - index) * 300_000,
        ).toISOString(),
        usage: 0.03 + index / 100,
        celsius: 56 + index,
        memoryUsed: 640 * 1024 ** 2,
      })),
    }),
    "/api/system/space": async () => plan,
    "/api/system/update": async (): Promise<UpdateStatus> => ({
      version: "dev-ed4f70b",
      channel: "dev",
      update: null,
    }),
    "/api/system/update/versions": async () => ({
      channel: "dev",
      versions: builds,
    }),
    "/api/system/restore": async () => ({ restore: null }),
    "/api/auth/clients": async () => [
      client({ current: true, connectedSince: today("09:00") }),
      client({
        id: "kitchen",
        name: "Kitchen tablet",
        kind: "shared",
        platform: "web",
        personId: null,
        connectedSince: today("07:12"),
      }),
      client({ id: "old", name: "Old phone", personId: "alex" }),
    ],
    "/api/people": async (): Promise<PersonInfo[]> => [
      { id: "alex", name: "Alex", colour: "#ff9f0a" } as PersonInfo,
    ],
    "/api/system/restart": async () => undefined,
    "/api/system/shutdown": async () => undefined,
    "/api/system/space/free": async () => ({ freed: 1_290_000_000 }),
  };
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    const answer = answers[path];
    if (!answer) throw new Error(`Unexpected request: ${path}`);
    return answer() as never;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// The core away, so the page's Updates asks nothing of it here.
const offline = { state: "offline" } as const;
const online = { state: "online", version: "dev-ed4f70b" } as const;

async function render(timeZone?: string, core: CoreStatus = offline) {
  await act(async () => {
    root.render(
      <HomeTimeZoneProvider timeZone={timeZone}>
        <TemperatureUnitProvider unit="celsius">
          <SystemPage
            apps={statusApps}
            core={core}
            onUpdating={() => {}}
            onDone={() => {}}
          />
        </TemperatureUnitProvider>
      </HomeTimeZoneProvider>,
    );
  });
  // The page's own requests settle.
  await act(async () => {});
}

const section = (id: string) =>
  container.querySelector(`section[aria-labelledby="${id}"]`)!;

const buttonIn = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll("button")].find(
    (button) => button.textContent === name,
  )!;

const dialog = () => document.querySelector('[role="dialog"]');

async function press(button: HTMLButtonElement) {
  await act(async () => button.click());
  await act(async () => {});
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("restart and shut down", () => {
  it("shows the power notice from the POST even without a live broadcast", async () => {
    const live = createLiveFeed();
    let going: Going | undefined;
    function Screen() {
      going = useGoing(live, "online");
      return (
        <SystemPage
          apps={statusApps}
          core={offline}
          onUpdating={() => {}}
          onDone={() => {}}
          onPowerAccepted={(action) =>
            live.publish({ type: "system", going: action })
          }
        />
      );
    }
    await act(async () => root.render(<Screen />));
    await press(buttonIn(section("status-sanctum"), "Shut down"));
    await press(buttonIn(dialog()!, "Shut down"));
    expect(going).toEqual({ action: "shutdown", away: false });
  });

  it("ask first, saying what happens, then ask the core", async () => {
    await render();
    const sanctum = section("status-sanctum");

    await press(buttonIn(sanctum, "Restart"));
    expect(dialog()?.querySelector("h2")?.textContent).toBe("Restart Sanctum?");
    expect(dialog()?.textContent).toContain(
      "It's away for about 2 minutes, then comes back by itself.",
    );
    expect(
      [...dialog()!.querySelectorAll("button")].map((each) => each.textContent),
    ).toEqual(["Cancel", "Restart"]);

    await press(buttonIn(dialog()!, "Restart"));
    expect(vi.mocked(coreJson)).toHaveBeenCalledWith("/api/system/restart", {
      method: "POST",
    });
    expect(dialog()).toBeNull();
    expect(buttonIn(sanctum, "Shut down").disabled).toBe(true);
  });

  it("say beside them why it couldn't, and what to do", async () => {
    answers["/api/system/shutdown"] = async () => {
      throw new CoreError(503, "manager_unavailable");
    };
    await render();
    const sanctum = section("status-sanctum");

    await press(buttonIn(sanctum, "Shut down"));
    expect(dialog()?.textContent).toContain(
      "To start it, unplug its power and plug it back in.",
    );
    await press(buttonIn(dialog()!, "Shut down"));
    expect(sanctum.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't shut downSanctum's updater isn't answering. Try again in a minute",
    );
    expect(buttonIn(sanctum, "Restart").disabled).toBe(false);
  });

  it("wait, dimmed, while an update runs", async () => {
    answers["/api/system/update"] = async (): Promise<UpdateStatus> => ({
      version: "dev-ed4f70b",
      channel: "dev",
      update: {
        id: "u1",
        version: "dev-1040943",
        from: null,
        startedAt: "2026-11-02T22:00:00Z",
        finishedAt: null,
        step: "download",
        outcome: null,
        error: null,
        log: [],
      },
    });
    await render(undefined, online);
    const sanctum = section("status-sanctum");
    expect(sanctum.textContent).toContain(
      "Restart and Shut down wait until the update has finished",
    );
    expect(buttonIn(sanctum, "Restart").disabled).toBe(true);
    expect(buttonIn(sanctum, "Shut down").disabled).toBe(true);
  });
});

describe("free up space", () => {
  it("waits for a fresh cleanup plan after an update", async () => {
    vi.useFakeTimers();
    await render(undefined, online);
    const storage = section("status-storage");
    await press(buttonIn(storage, "Free up space"));
    expect(dialog()?.textContent).toContain("dev-b7df8ce before it");

    const refreshed = deferred<SpacePlan>();
    answers["/api/system/space"] = () => refreshed.promise;
    answers["/api/system/update"] = async (): Promise<UpdateStatus> => ({
      version: "dev-1040943",
      channel: "dev",
      update: {
        id: "u1",
        version: "dev-1040943",
        from: "dev-ed4f70b",
        startedAt: "2026-11-02T22:00:00Z",
        finishedAt: "2026-11-02T22:02:00Z",
        step: "done",
        outcome: "updated",
        error: null,
        log: [],
      },
    });
    await act(async () => vi.advanceTimersByTimeAsync(10_000));
    expect(buttonIn(dialog()!, "Free up space").disabled).toBe(true);
    await press(buttonIn(dialog()!, "Cancel"));
    expect(buttonIn(storage, "Free up space").disabled).toBe(true);

    await act(async () =>
      refreshed.resolve({
        ...plan,
        keeps: { running: "dev-1040943", before: "dev-ed4f70b", newest: null },
      }),
    );
    await press(buttonIn(storage, "Free up space"));
    expect(dialog()?.textContent).toContain("dev-ed4f70b before it");
    expect(dialog()?.textContent).not.toContain("dev-b7df8ce");
    expect(buttonIn(dialog()!, "Free up space").disabled).toBe(false);
  });

  it("drops a chosen build that cleanup removed before allowing another update", async () => {
    await render(undefined, online);
    const updates = section("status-updates");
    const buildsRow = () =>
      [...updates.querySelectorAll("button")].find((button) =>
        button.textContent?.startsWith("Builds"),
      )!;
    await press(buildsRow());
    await act(async () =>
      updates
        .querySelector<HTMLInputElement>('input[value="dev-older"]')!
        .click(),
    );
    await press(buildsRow());
    expect(buttonIn(updates, "Update to dev-older").disabled).toBe(false);

    const freed = deferred<{ freed: number }>();
    const refreshed = deferred<{
      channel: string;
      versions: typeof builds;
    }>();
    answers["/api/system/space/free"] = () => freed.promise;
    answers["/api/system/update/versions"] = () => refreshed.promise;
    await press(buttonIn(section("status-storage"), "Free up space"));
    await press(buttonIn(dialog()!, "Free up space"));
    expect(buttonIn(updates, "Update to dev-older").disabled).toBe(true);
    await act(async () => freed.resolve({ freed: 100 }));
    expect(buttonIn(updates, "Update to dev-older").disabled).toBe(true);

    await act(async () =>
      refreshed.resolve({ channel: "dev", versions: builds.slice(0, 3) }),
    );
    expect(buildsRow().textContent).toBe("Buildsdev-1040943 chosen · 3 builds");
    expect(buttonIn(updates, "Update to dev-1040943").disabled).toBe(false);
  });

  it("retries when the manager could not count old versions on opening", async () => {
    vi.useFakeTimers();
    answers["/api/system/space"] = async () => {
      throw new CoreError(503, "manager_unavailable");
    };
    await render();
    const storage = section("status-storage");
    expect(storage.textContent).toContain("Can't count them right now");
    expect(buttonIn(storage, "Free up space").disabled).toBe(true);
    answers["/api/system/space"] = async () => plan;
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(storage.textContent).toContain("About 1.3 GB to free");
    expect(buttonIn(storage, "Free up space").disabled).toBe(false);
  });

  it("says what it would free and what goes, then what stays, asked first", async () => {
    await render();
    const storage = section("status-storage");
    expect(storage.textContent).toContain(
      "Old versionsAbout 1.3 GB to free: 11 dev builds and an old version of Zigbee",
    );

    await press(buttonIn(storage, "Free up space"));
    expect(dialog()?.querySelector("h2")?.textContent).toBe(
      "Free up about 1.3 GB?",
    );
    expect(dialog()?.querySelector("p")?.textContent).toBe(
      "Removes 11 dev builds and an old version of Zigbee. Keeps dev-ed4f70b, which is running, dev-b7df8ce before it, to go back to, and dev-1040943, the newest, to update to.",
    );

    await press(buttonIn(dialog()!, "Free up space"));
    expect(vi.mocked(coreJson)).toHaveBeenCalledWith("/api/system/space/free", {
      method: "POST",
    });
    expect(storage.querySelector('[role="status"]')?.textContent).toBe(
      "Freed 1.29 GBOnly the version running, the one before and the newest are kept",
    );
  });

  it("says when the updater doesn't answer after confirming Free up space", async () => {
    answers["/api/system/space/free"] = async () => {
      throw new CoreError(503, "manager_unavailable");
    };
    await render();
    const storage = section("status-storage");

    await press(buttonIn(storage, "Free up space"));
    await press(buttonIn(dialog()!, "Free up space"));

    expect(storage.querySelector('[role="status"]')?.textContent).toContain(
      "Sanctum's updater isn't answering. Try again in a minute",
    );
  });

  it("says when there is nothing to free, its button dimmed", async () => {
    answers["/api/system/space"] = async () => ({
      ...plan,
      bytes: 0,
      images: [],
      devBuilds: 0,
      keeps: { running: "1.4.0", before: "1.3.2", newest: null },
    });
    await render();
    const storage = section("status-storage");
    expect(storage.textContent).toContain(
      "Nothing to free up: only this version and the one before are kept",
    );
    expect(buttonIn(storage, "Free up space").disabled).toBe(true);
  });

  it("is the fix of storage almost full, while there is something to free", async () => {
    status.host!.storage!.free = 900_000_000;
    status.problems = [{ kind: "storage", free: 900_000_000 }];
    await render();
    const verdict = section("status-sanctum").querySelector('[role="status"]')!;
    expect(buttonIn(verdict, "Free up space")).toBeDefined();
  });
});

it("shows a restore notice while host status is loading", async () => {
  const hostStatus = deferred<SystemStatus>();
  answers["/api/system/status"] = () => hostStatus.promise;
  answers["/api/system/restore"] = async () => ({
    restore: { restoredAt: "2026-11-02T22:00:00Z", backupAt: null },
  });
  await render(undefined, online);
  const sanctum = section("status-sanctum");
  expect(sanctum.querySelector('[aria-busy="true"]')).not.toBeNull();
  expect(sanctum.textContent).toContain(
    "Restored from a backup. All devices were signed out.",
  );

  await act(async () => hostStatus.resolve(status));
  expect(sanctum.querySelector('[aria-busy="true"]')).toBeNull();
  expect(sanctum.textContent).toContain("Restored from a backup.");
  expect(
    vi
      .mocked(coreJson)
      .mock.calls.filter(([path]) => path === "/api/system/restore"),
  ).toHaveLength(1);
});

describe("the last 24 hours", () => {
  it("refreshes at the pending boundary when opened just after five minutes end", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T22:30:05Z"));
    const history = vi.fn(answers["/api/system/history"]!);
    answers["/api/system/history"] = history;
    await render();
    expect(history).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(9_999));
    expect(history).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(history).toHaveBeenCalledTimes(2);
    await act(async () => vi.advanceTimersByTimeAsync(300_000));
    expect(history).toHaveBeenCalledTimes(3);
  });

  it("gives up on a look at the day that never answers", async () => {
    await render();
    const looks = vi
      .mocked(coreJson)
      .mock.calls.filter(([path]) => path === "/api/system/history");
    expect(looks.length).toBeGreaterThan(0);
    for (const [, init] of looks)
      expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("asks again at once when a slow answer comes after the 5 minutes end", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T22:34:58Z"));
    const quick = answers["/api/system/history"]!;
    const history = vi.fn(
      () =>
        new Promise((resolve) => setTimeout(() => resolve(quick()), 20_000)),
    );
    answers["/api/system/history"] = history;
    await render();
    expect(history).toHaveBeenCalledTimes(1);
    // The first answer comes at 22:35:18, after the look due at 22:35:15.
    await act(async () => vi.advanceTimersByTimeAsync(20_000));
    await act(async () => vi.advanceTimersByTimeAsync(100));
    expect(history).toHaveBeenCalledTimes(2);
  });

  it("does not turn an unrefreshed day into missing readings while Status advances", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-03T22:30:20Z"));
    // The chart uses the host's clock even when the client's is different.
    const hostNow = () => Date.now() + 2 * 60 * 60_000;
    answers["/api/system/status"] = async () =>
      piStatus({ checkedAt: new Date(hostNow()).toISOString() });
    const start = Math.floor(hostNow() / 300_000) * 300_000 - 300_000;
    const points: HostPoint[] = [
      {
        at: new Date(start).toISOString(),
        usage: 0.04,
        celsius: 56,
        memoryUsed: 640 * 1024 ** 2,
      },
    ];
    answers["/api/system/history"] = async () => ({ points });
    await render();
    answers["/api/system/history"] = async () => {
      throw new CoreError(503, "manager_unavailable");
    };
    await act(async () => vi.advanceTimersByTimeAsync(6 * 60_000));
    const day = section("status-day");
    expect(day.querySelectorAll("polyline")).toHaveLength(4);

    // A successful refresh can establish a real gap, including one at the end.
    answers["/api/system/history"] = async () => ({ points });
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(day.querySelectorAll("polyline")).toHaveLength(0);
  });

  it("heads each chart with its name and what it reads now, and nothing more", async () => {
    status.checkedAt = "2026-11-03T18:27:00Z";
    answers["/api/system/history"] = async () => ({
      points: [56, 84, 58].map((celsius, index): HostPoint => ({
        at: `2026-11-03T18:${10 + 5 * index}:00Z`,
        usage: 0.03 + index / 100,
        celsius,
        memoryUsed: 640 * 1024 ** 2,
      })),
    });
    await render("Europe/Zurich");
    const day = section("status-day");
    expect(
      [...day.querySelectorAll("h3")].map((heading) => {
        const header = heading.parentElement!;
        expect([...header.children].map((child) => child.tagName)).toEqual([
          "H3",
          "P",
        ]);
        return [...header.children].map((child) => child.textContent);
      }),
    ).toEqual([
      ["Processor", "3% now"],
      ["Temperature", "58°C now · normal"],
      ["Memory in use", "627 MB now"],
    ]);
    expect(day.textContent).not.toMatch(
      /on average|busiest|no readings|Too hot from/,
    );
    expect(
      [...day.querySelectorAll('[role="group"]')].map((chart) =>
        chart.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Processor in use over the last 24 hours",
      "Temperature over the last 24 hours. Too hot from 19:15 to 19:20.",
      "Memory in use over the last 24 hours",
    ]);
  });

  it("explains when there are no processor readings", async () => {
    status.host!.processor.usage = null;
    answers["/api/system/history"] = async () => ({ points: [] });
    await render();
    const day = section("status-day");
    expect(day.textContent).toContain("ProcessorNothing read yet");
    expect(
      day.querySelector(
        '[aria-label="Processor in use over the last 24 hours"]',
      ),
    ).toBeNull();
  });

  it.each([
    { live: null, past: 56, shown: true },
    { live: 58, past: null, shown: true },
    { live: null, past: null, shown: false },
  ])(
    "shows the temperature chart for live $live and past $past only when there is a reading",
    async ({ live, past, shown }) => {
      status.checkedAt = "2026-11-03T18:27:00Z";
      status.host!.processor.celsius = live;
      const point: HostPoint = {
        at: "2026-11-03T18:15:00Z",
        usage: 0.04,
        celsius: past,
        memoryUsed: 640 * 1024 ** 2,
      };
      answers["/api/system/history"] = async () => ({ points: [point] });
      await render();
      const chart = section("status-day").querySelector(
        '[role="group"][aria-label="Temperature over the last 24 hours"]',
      );
      expect(chart !== null).toBe(shown);
    },
  );

  it("says what each reads now while its day is on its way", async () => {
    answers["/api/system/history"] = () => new Promise(() => {});
    await render();
    const day = section("status-day");
    expect(day.textContent).toBe(
      "Last 24 HoursProcessor3% nowTemperature58°C now · normalMemory in use627 MB now",
    );
    expect(day.querySelectorAll('[aria-busy="true"]')).toHaveLength(3);
  });

  it("says what each reads now, and that its day isn't known, while updates and services don't answer", async () => {
    answers["/api/system/history"] = async () => {
      throw new CoreError(503, "manager_unavailable");
    };
    await render();
    expect(section("status-day").textContent).toBe(
      "Last 24 HoursProcessor3% nowTemperature58°C now · normalMemory in use627 MB nowNot known right nowShows again once Sanctum's updater answers",
    );
  });
});

describe("connected now", () => {
  it("does not count this device while its live connection is closed", async () => {
    answers["/api/auth/clients"] = async () => [client({ current: true })];
    await render();
    const connected = section("status-connected");
    expect(connected.querySelector("h2 + span")?.textContent).toBe(
      "0 of 1 linked device",
    );
    expect(connected.querySelectorAll("li")).toHaveLength(0);
  });
  it("lists the linked devices with a live connection, this device first", async () => {
    await render();
    const connected = section("status-connected");
    expect(connected.querySelector("h2 + span")?.textContent).toBe(
      "2 of 3 linked devices",
    );
    expect(
      [...connected.querySelectorAll("li")].map((row) => row.textContent),
    ).toEqual([
      "AAlex's MacAlex · macOS · this device",
      "Kitchen tabletShared · Web browser · since 07:12",
    ]);
  });

  it("says Connected now in Settings → Linked Devices", () => {
    expect(
      clientDetail(
        clock,
        client({ connectedSince: today("07:12"), lastSeenAt: today("07:12") }),
        undefined,
      ),
    ).toBe("Personal · macOS · Connected now");
  });
});

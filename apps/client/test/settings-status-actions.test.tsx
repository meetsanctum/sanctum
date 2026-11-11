// @vitest-environment jsdom
import type { ClientInfo, PersonInfo } from "@meetsanctum/auth-protocol";
import { createLiveFeed, TemperatureUnitProvider } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreError, coreJson } from "../src/core-fetch";
import { clientDetail } from "../src/settings-clients";
import { useGoing, type Going } from "../src/power-notice";
import { StatusPage } from "../src/settings-status";
import type { SpacePlan } from "../src/settings-status-space";
import type { SystemStatus } from "../src/system-status";
import type { HostPoint } from "../src/system-status-day";
import type { UpdateStatus } from "../src/system-update";
import { piStatus, statusApps } from "./system-status-fixtures";

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
  // The charts measure their width.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
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
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => {
    root.render(
      <TemperatureUnitProvider unit="celsius">
        <StatusPage apps={statusApps} onDone={() => {}} />
      </TemperatureUnitProvider>,
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

describe("restart and shut down", () => {
  it("shows the power notice from the POST even without a live broadcast", async () => {
    const live = createLiveFeed();
    let going: Going | undefined;
    function Screen() {
      going = useGoing(live, "online");
      return (
        <StatusPage
          apps={statusApps}
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
      "Couldn't shut downUpdates and services isn't answering. Try again in a minute",
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
    await render();
    const sanctum = section("status-sanctum");
    expect(sanctum.textContent).toContain(
      "Restart and Shut down wait until the update has finished",
    );
    expect(buttonIn(sanctum, "Restart").disabled).toBe(true);
    expect(buttonIn(sanctum, "Shut down").disabled).toBe(true);
  });
});

describe("free up space", () => {
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
    expect(day.textContent).not.toContain("no readings");
    expect(day.querySelectorAll("polyline")).toHaveLength(4);

    // A successful refresh can establish a real gap, including one at the end.
    answers["/api/system/history"] = async () => ({ points });
    await act(async () => vi.advanceTimersByTimeAsync(5 * 60_000));
    expect(day.textContent).toContain("no readings");
    expect(day.querySelectorAll("polyline")).toHaveLength(0);
  });

  it("heads each chart with what it reads now, then what its day came to", async () => {
    await render();
    const day = section("status-day");
    expect(
      [...day.querySelectorAll("h3")].map((heading) => heading.textContent),
    ).toEqual(["Processor", "Temperature", "Memory in use"]);
    // A day of three readings so far.
    expect(day.textContent).toMatch(
      /Processor3% now4% on average since \d\d:\d\d · busiest at \d\d:\d\d, 5%/,
    );
    expect(day.textContent).toContain("Temperature58°C now · normal");
    expect(
      [...day.querySelectorAll('[role="group"]')].map((chart) =>
        chart.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Processor in use over the last 24 hours",
      "Temperature over the last 24 hours",
      "Memory in use over the last 24 hours",
    ]);
  });

  it("says what each reads now while its day is on its way", async () => {
    answers["/api/system/history"] = () => new Promise(() => {});
    await render();
    const day = section("status-day");
    expect(day.textContent).toBe(
      "Last 24 hoursProcessor3% nowTemperature58°C now · normalMemory in use627 MB now",
    );
    expect(day.querySelectorAll('[aria-busy="true"]')).toHaveLength(3);
  });

  it("says what each reads now, and that its day isn't known, while updates and services don't answer", async () => {
    answers["/api/system/history"] = async () => {
      throw new CoreError(503, "manager_unavailable");
    };
    await render();
    expect(section("status-day").textContent).toBe(
      "Last 24 hoursProcessor3% nowTemperature58°C now · normalMemory in use627 MB nowNot known right nowShows again once Updates and services answers",
    );
  });
});

describe("connected now", () => {
  it("does not count this device while its live connection is closed", async () => {
    answers["/api/auth/clients"] = async () => [client({ current: true })];
    await render();
    const connected = section("status-connected");
    expect(connected.querySelector("h2 + span")?.textContent).toBe(
      "0 of 1 client",
    );
    expect(connected.querySelectorAll("li")).toHaveLength(0);
  });
  it("lists the clients with a live connection, this device first", async () => {
    await render();
    const connected = section("status-connected");
    expect(connected.querySelector("h2 + span")?.textContent).toBe(
      "2 of 3 clients",
    );
    expect(
      [...connected.querySelectorAll("li")].map((row) => row.textContent),
    ).toEqual([
      "AAlex's MacAlex · macOS · this device",
      "Kitchen tabletShared · Web browser · since 07:12",
    ]);
  });

  it("says Connected now in Settings → Clients", () => {
    expect(
      clientDetail(
        client({ connectedSince: today("07:12"), lastSeenAt: today("07:12") }),
        undefined,
      ),
    ).toBe("Personal · macOS · Connected now");
  });
});

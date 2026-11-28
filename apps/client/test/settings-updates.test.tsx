// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { CoreError, coreJson } from "../src/core-fetch";
import type { CoreStatus } from "../src/core-status";
import { Home } from "../src/Home";
import type { StoredHost } from "../src/shell";
import type { SystemStatus } from "../src/system-status";
import type { UpdateInfo } from "../src/system-update";
import { piStatus } from "./system-status-fixtures";
import { problemLines } from "./problem-lines";

// Settings → System's Updates and the connection veil: someone updates the
// host from the UI, the screen rides out the core's restart, and a shared
// client gets the version and the updates too.

const fake = vi.hoisted(() => ({
  report: (_status: CoreStatus) => {},
  retries: 0,
}));

vi.mock("../src/core-fetch", async (original) => ({
  ...(await original<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));
vi.mock("../src/auth/session", () => ({
  followHost: (host: StoredHost, found: (url: string) => void) => {
    found(host.url);
    return () => {};
  },
}));
vi.mock("../src/core-status", () => ({
  startCoreStatusPolling: (onStatus: (status: CoreStatus) => void) => {
    fake.report = onStatus;
    onStatus({ state: "online", version: "dev-1" });
    return { stop() {}, checkNow() {} };
  },
}));
vi.mock("../src/live", () => ({
  connectLive: () => ({
    stop() {},
    retryNow() {
      fake.retries += 1;
    },
  }),
}));

const host: StoredHost = {
  hostId: "host",
  homeId: "home",
  name: "Home",
  url: "http://localhost:4100",
  clientId: "client",
  token: "test-token",
  kind: "personal",
  pin: null,
};

const admin = {
  client: { id: "client", name: "Mac", kind: "personal" },
  person: { id: "maya", name: "Maya", colour: "#c5cdac" },
};
const tablet = {
  client: { id: "tablet", name: "Kitchen tablet", kind: "shared" },
  person: null,
};

const update = (changes: Partial<UpdateInfo> = {}): UpdateInfo => ({
  id: "u1",
  version: "dev-3",
  from: null,
  startedAt: "2026-10-28T10:00:00.000Z",
  finishedAt: null,
  step: "download",
  outcome: null,
  error: null,
  log: [],
  ...changes,
});

let root: Root;
let container: HTMLDivElement;
let me: object;
let journal: UpdateInfo | null;
let asked: string[];
let started: unknown[];
let hostStatus: SystemStatus;
let statusFails: boolean;

async function render() {
  await act(async () => {
    root.render(
      <Home
        host={host}
        onHostMoved={() => {}}
        onSignedOut={() => {}}
        onCertificateChanged={() => {}}
      />,
    );
  });
}

// Settings and Automations load when first opened (Home.tsx): loaded here
// first, they open as quickly as the tests look for them.
beforeAll(() =>
  Promise.all([import("../src/settings"), import("../src/automations/page")]),
);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  me = admin;
  journal = null;
  asked = [];
  started = [];
  hostStatus = piStatus();
  statusFails = false;
  fake.retries = 0;
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init) => {
    asked.push(path);
    switch (path) {
      case "/api/auth/me":
        return me;
      case "/api/apps":
      case "/api/devices":
        return [];
      case "/api/places":
        return {
          home: { name: "Home", timeZone: "Europe/Zurich", hourCycle: "12h" },
          floors: [],
          rooms: [],
          zones: [],
        };
      case "/api/system/update":
        return { version: "dev-1", channel: "dev", update: journal };
      case "/api/system/update/versions":
        return {
          channel: "dev",
          versions: [
            { version: "dev-3", builtAt: "2026-10-27T23:30:00Z" },
            { version: "dev-2", builtAt: "2026-10-27T09:00:00Z" },
            { version: "dev-1", builtAt: "2026-10-26T09:00:00Z" },
          ],
        };
      case "/api/system/update/start":
        started.push(init?.json);
        journal = update();
        return { update: journal };
      case "/api/system/restore":
        return { restore: null };
      case "/api/system/status":
        if (statusFails) throw new Error("The core did not answer");
        return hostStatus;
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function openSettings() {
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>('aside button[aria-label="Apps"]')!
      .click();
  });
  await act(async () => {
    [...container.querySelectorAll<HTMLButtonElement>("main li button")]
      .find((button) => button.textContent === "Settings")!
      .click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

// Settings' System page, from its row on the first page.
async function openSystem() {
  await openSettings();
  await act(async () => {
    areaRow("System")!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

// A row of Settings' first page, by its area's name.
const areaRow = (area: string) =>
  [
    ...container.querySelectorAll<HTMLButtonElement>(
      'nav[aria-label="Settings"] button',
    ),
  ].find((button) => button.textContent?.startsWith(area));

// The System page's Updates card.
const system = () =>
  container.querySelector('section[aria-labelledby="status-updates"]')!;

// The dev channel's builds, folded under their row until it is pressed.
const buildsRow = () =>
  [...system().querySelectorAll<HTMLButtonElement>("button")].find((each) =>
    each.textContent?.startsWith("Builds"),
  );

async function openBuilds() {
  await act(async () => buildsRow()!.click());
}

function button(text: string, within: ParentNode = document) {
  return [...within.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );
}

async function report(status: CoreStatus) {
  await act(async () => {
    fake.report(status);
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

const veil = () => container.querySelector(".veil");

describe("the connection veil", () => {
  it("covers the page while the core is away and goes when it is back", async () => {
    await render();
    const main = container.querySelector("main")!;
    expect(veil()).toBeNull();

    await report({ state: "offline" });
    expect(veil()?.textContent).toContain("Reconnecting");
    expect(main.closest("[inert]")).not.toBeNull();

    // A new core waiting for its update to commit.
    await report({ state: "updating", version: "dev-2" });
    expect(veil()?.textContent).toContain("Updating");

    const before = asked.filter((path) => path === "/api/auth/me").length;
    await report({ state: "online", version: "dev-2" });
    expect(veil()).toBeNull();
    expect(main.closest("[inert]")).toBeNull();
    // It reconnects at once and reads everything again.
    expect(fake.retries).toBe(1);
    expect(asked.filter((path) => path === "/api/auth/me").length).toBe(
      before + 1,
    );
  });
});

describe("Settings → System", () => {
  it("gives a shared client the version and the updates too", async () => {
    me = tablet;
    await render();
    await openSystem();

    expect(system().textContent).toContain("dev-1");
    expect(asked).toContain("/api/system/update");
  });

  it("opens one page with how Sanctum is doing and its updates, a green check while everything's running", async () => {
    await render();
    await openSettings();
    expect(
      container.querySelector('section[aria-labelledby="settings-attention"]'),
    ).toBeNull();
    expect(areaRow("System")?.getAttribute("aria-label")).toBe(
      "System: everything's running",
    );
    await openSystem();

    expect(container.querySelector(".top-bar h1")?.textContent).toBe("System");
    const sanctum = container.querySelector(
      'section[aria-labelledby="status-sanctum"]',
    )!;
    expect(
      sanctum.querySelector('[role="status"] span.text-green')?.textContent,
    ).toBe("Everything's running");
    // The version is said once, in Updates.
    expect(sanctum.textContent).not.toContain("Version");
    expect(system().textContent).toContain("Versiondev-1 · Dev channel");
  });

  it("puts Sanctum first in Needs attention while its clock isn't synchronised, and both open Status", async () => {
    hostStatus = piStatus({ problems: [{ kind: "clock" }] });
    await render();
    await openSettings();

    expect(areaRow("System")?.textContent).toBe("SystemClock not synchronised");
    const attention = container.querySelector(
      'section[aria-labelledby="settings-attention"]',
    )!;
    expect(attention.textContent).toContain("Needs AttentionSanctum");
    const sanctum = button("SanctumClock not synchronised", attention)!;
    expect(sanctum.getAttribute("aria-label")).toBe(
      "Sanctum: Clock not synchronised. Opens System",
    );

    await act(async () => {
      sanctum.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(container.textContent).toContain("Clock not synchronised");
    expect(container.textContent).toContain(
      "Devices may refuse Sanctum's certificate until it is: check that Sanctum can reach the internet",
    );
    expect(asked).toContain("/api/system/status");
  });

  it("keeps no old reading in Needs attention once the status can't be read", async () => {
    hostStatus = piStatus({ problems: [{ kind: "clock" }] });
    await render();
    await openSettings();
    const attention = () =>
      container.querySelector('section[aria-labelledby="settings-attention"]');
    expect(attention()?.textContent).toContain("Clock not synchronised");

    // Ask again under fake timers, as when the core comes back, and fail.
    await report({ state: "offline" });
    vi.useFakeTimers();
    statusFails = true;
    await act(async () => fake.report({ state: "online", version: "dev-1" }));
    await act(async () => vi.advanceTimersByTimeAsync(0));

    expect(attention()).toBeNull();
    expect(areaRow("System")?.textContent).toBe("SystemCan't check right now");
  });

  it("shows builds and the last update on the home clock", async () => {
    journal = update({
      version: "dev-1",
      startedAt: "2026-10-26T23:30:00Z",
      finishedAt: "2026-10-26T23:45:00Z",
      step: "done",
      outcome: "updated",
    });
    await render();
    await openSystem();

    // Folded at first, saying which build is chosen.
    expect(buildsRow()?.getAttribute("aria-expanded")).toBe("false");
    expect(buildsRow()?.textContent).toBe("Buildsdev-3 chosen · 3 builds");
    expect(system().textContent).not.toContain("Built 28 Oct");
    await openBuilds();
    expect(buildsRow()?.getAttribute("aria-expanded")).toBe("true");
    expect(system().textContent).toContain("Built 28 Oct, 12:30 AM");
    expect(system().textContent).toContain(
      "Updated to dev-1 · 27 Oct, 12:45 AM",
    );
  });

  it("updates the host to a build someone chose, once they confirm", async () => {
    await render();
    await openSystem();
    // Update names the chosen build while the list is folded.
    expect(button("Update to dev-3", system())).toBeDefined();
    await openBuilds();

    // The newest build is chosen; the running one cannot be.
    const radios = [
      ...system().querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ];
    expect(
      radios.map((radio) => [radio.value, radio.checked, radio.disabled]),
    ).toEqual([
      ["dev-3", true, false],
      ["dev-2", false, false],
      ["dev-1", false, true],
    ]);
    await act(async () => radios[1]!.click());
    await act(async () => buildsRow()!.click());
    expect(buildsRow()?.getAttribute("aria-expanded")).toBe("false");
    expect(buildsRow()?.textContent).toBe("Buildsdev-2 chosen · 3 builds");

    await act(async () => button("Update to dev-2", system())!.click());
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      "goes back to dev-1 by itself",
    );
    expect(started).toEqual([]);

    await act(async () => {
      button("Update", document.querySelector('[role="dialog"]')!)!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(started).toEqual([{ version: "dev-2" }]);
    expect(system().textContent).toContain("Updating to dev-3");
    expect(system().textContent).toContain("Downloading dev-3");
    expect(button("Update to dev-2", system())).toBeUndefined();
    const sanctum = container.querySelector(
      '[aria-labelledby="status-sanctum"]',
    )!;
    expect(button("Restart", sanctum)?.disabled).toBe(true);
    expect(button("Shut down", sanctum)?.disabled).toBe(true);
  });

  it("says when an update rolled back, and why", async () => {
    journal = update({ step: "check", from: "dev-1" });
    await render();
    await openSystem();
    expect(system().querySelector('[aria-current="step"]')?.textContent).toBe(
      "Checking that it works",
    );

    // The core restarts as the update rolls back.
    await report({ state: "offline" });
    expect(veil()?.textContent).toContain("Updating");
    journal = update({
      step: "done",
      from: "dev-1",
      outcome: "rolled-back",
      error: "sanctum-core stopped",
      finishedAt: "2026-10-28T10:02:00.000Z",
    });
    await report({ state: "online", version: "dev-1" });

    expect(veil()).toBeNull();
    expect(system().textContent).toContain("The update was rolled back");
    expect(system().textContent).toContain(
      "dev-3 did not start, so your home went back to dev-1.",
    );
    expect(system().textContent).toContain("Reason: sanctum-core stopped");

    // The build that just failed is offered again only when chosen.
    expect(buildsRow()?.textContent).toBe("BuildsNone chosen · 3 builds");
    await openBuilds();
    const radios = [
      ...system().querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ];
    expect(radios.map((radio) => radio.checked)).toEqual([false, false, false]);
    expect(button("Update", system())?.disabled).toBe(true);
    await act(async () => radios[0]!.click());
    expect(button("Update to dev-3", system())?.disabled).toBe(false);
  });

  it("keeps the progress while the manager replaces itself", async () => {
    journal = update({ step: "backup", from: "dev-1" });
    await render();
    await openSystem();

    // The new core is up and committed; the manager is away for a moment.
    await report({ state: "offline" });
    const original = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation(async (path, init) => {
      if (path === "/api/system/update") {
        throw new CoreError(503, "manager_unavailable");
      }
      return original(path, init);
    });
    await report({ state: "online", version: "dev-3" });

    expect(system().querySelector('[aria-current="step"]')?.textContent).toBe(
      "Finishing",
    );
  });

  it.each(["stable", "edge"])(
    "can update a %s host reporting its channel when versions didn't load",
    async (channel) => {
      const original = vi.mocked(coreJson).getMockImplementation()!;
      vi.mocked(coreJson).mockImplementation(async (path, init) => {
        if (path === "/api/system/update") {
          return { version: channel, channel, update: null };
        }
        if (path === "/api/system/update/versions") {
          throw new CoreError(503, "manager_unavailable");
        }
        return original(path, init);
      });
      await render();
      await report({ state: "online", version: channel });
      await openSystem();

      expect(system().querySelector('[role="alert"]')).toBeNull();
      expect(button("Update", system())?.disabled).toBe(false);
      await act(async () => button("Update", system())!.click());
      await act(async () =>
        button("Update", document.querySelector('[role="dialog"]')!)!.click(),
      );
      expect(started).toEqual([{ version: channel }]);
    },
  );

  it.each(["succeeds", "fails"])(
    "keeps the update-start error when a pending version lookup %s",
    async (outcome) => {
      const original = vi.mocked(coreJson).getMockImplementation()!;
      let finishLookup!: () => void;
      vi.mocked(coreJson).mockImplementation(async (path, init) => {
        if (path === "/api/system/update") {
          return { version: "stable", channel: "stable", update: null };
        }
        if (path === "/api/system/update/versions") {
          return new Promise((resolve, reject) => {
            finishLookup = () => {
              if (outcome === "fails")
                reject(new CoreError(503, "manager_unavailable"));
              else resolve({ channel: "stable", versions: [] });
            };
          });
        }
        if (path === "/api/system/update/start")
          throw new CoreError(409, "busy");
        return original(path, init);
      });
      await render();
      await report({ state: "online", version: "stable" });
      await openSystem();
      await act(async () => button("Update", system())!.click());
      await act(async () =>
        button("Update", document.querySelector('[role="dialog"]')!)!.click(),
      );
      await act(async () => finishLookup());

      expect(problemLines(system().querySelector('[role="alert"]'))).toEqual([
        "The update didn't start",
        "Another update is already running.",
      ]);
    },
  );

  it("says in its card when an update didn't start", async () => {
    const original = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation(async (path, init) => {
      if (path === "/api/system/update/start") throw new CoreError(409, "busy");
      return original(path, init);
    });
    await render();
    await openSystem();
    await act(async () => button("Update to dev-3", system())!.click());
    await act(async () => {
      button("Update", document.querySelector('[role="dialog"]')!)!.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(problemLines(system().querySelector('[role="alert"]'))).toEqual([
      "The update didn't start",
      "Another update is already running.",
    ]);
    expect(button("Update to dev-3", system())?.disabled).toBe(false);
  });

  it("retries a build list that failed while the manager was away", async () => {
    const original = vi.mocked(coreJson).getMockImplementation()!;
    let isAway = true;
    vi.mocked(coreJson).mockImplementation(async (path, init) => {
      if (path === "/api/system/update/versions" && isAway) {
        throw new CoreError(503, "manager_unavailable");
      }
      return original(path, init);
    });
    await render();
    await openSystem();
    expect(problemLines(system().querySelector('[role="alert"]'))).toEqual([
      "Versions didn't load",
      "Sanctum didn't answer. It asks again every few seconds.",
    ]);
    expect(system().textContent).not.toContain("No builds yet.");

    // Restart the effect under fake timers, as when the core comes back.
    await report({ state: "offline" });
    vi.useFakeTimers();
    await act(async () => fake.report({ state: "online", version: "dev-1" }));
    isAway = false;
    await act(async () => vi.advanceTimersByTimeAsync(2_000));
    expect(button("Update to dev-3", system())?.disabled).toBe(false);
    expect(system().querySelector('[role="alert"]')).toBeNull();
  });

  it("keeps an accepted start when an older status response arrives in the same render", async () => {
    await render();
    await openSystem();
    await report({ state: "offline" });
    let resolveStatus!: (value: unknown) => void;
    let resolveStart!: (value: unknown) => void;
    const original = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation(async (path, init) => {
      if (path === "/api/system/update") {
        return new Promise((resolve) => {
          resolveStatus = resolve;
        });
      }
      if (path === "/api/system/update/start") {
        return new Promise((resolve) => {
          resolveStart = resolve;
        });
      }
      return original(path, init);
    });
    await report({ state: "online", version: "dev-1" });
    await act(async () => button("Update to dev-3", system())!.click());
    await act(async () =>
      button("Update", document.querySelector('[role="dialog"]')!)!.click(),
    );
    await act(async () => {
      resolveStart({ update: update() });
      resolveStatus({ version: "dev-1", channel: "dev", update: null });
    });
    expect(system().textContent).toContain("Downloading dev-3");
    expect(button("Update to dev-3", system())).toBeUndefined();
  });
});

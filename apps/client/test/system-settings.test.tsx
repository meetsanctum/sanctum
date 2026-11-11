// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreError, coreJson } from "../src/core-fetch";
import type { CoreStatus } from "../src/core-status";
import { Home } from "../src/Home";
import type { StoredHost } from "../src/shell";
import type { SystemStatus } from "../src/system-status";
import type { UpdateInfo } from "../src/system-update";
import { piStatus } from "./system-status-fixtures";

// Settings → System and the connection veil: someone updates the host from
// the UI, the screen rides out the core's restart, and a shared client gets
// the version and the updates too.

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
        return [];
      case "/api/system/update":
        return { version: "dev-1", channel: "dev", update: journal };
      case "/api/system/update/versions":
        return {
          channel: "dev",
          versions: [
            { version: "dev-3", builtAt: "2026-10-28T09:00:00Z" },
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

const system = () =>
  container.querySelector('section[aria-labelledby="settings-system"]')!;

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
    await openSettings();

    expect(system().textContent).toContain("dev-1");
    expect(asked).toContain("/api/system/update");
  });

  it("starts with Status, a green check while everything's running", async () => {
    await render();
    await openSettings();

    const row = button(
      "StatusEverything's running · 6.92 GB free · 58°C",
      system(),
    );
    expect(row?.getAttribute("aria-label")).toBe(
      "Status: everything's running. Opens Status",
    );
    expect(row?.querySelector("span.text-green")?.textContent).toBe(
      "Everything's running",
    );
    expect(
      container.querySelector('section[aria-labelledby="settings-attention"]'),
    ).toBeNull();
  });

  it("puts Sanctum first in Needs attention while its clock isn't synchronised, and both open Status", async () => {
    hostStatus = piStatus({ problems: [{ kind: "clock" }] });
    await render();
    await openSettings();

    expect(system().textContent).toContain("StatusClock not synchronised");
    const attention = container.querySelector(
      'section[aria-labelledby="settings-attention"]',
    )!;
    expect(attention.textContent).toContain("Needs attentionSanctum");
    const sanctum = button("SanctumClock not synchronised", attention)!;
    expect(sanctum.getAttribute("aria-label")).toBe(
      "Sanctum: Clock not synchronised. Opens Status",
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
    expect(system().textContent).toContain("StatusCan't check right now");
  });

  it("updates the host to a build someone chose, once they confirm", async () => {
    await render();
    await openSettings();

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
  });

  it("says when an update rolled back, and why", async () => {
    journal = update({ step: "check", from: "dev-1" });
    await render();
    await openSettings();
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
    await openSettings();

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
    "can update a %s host already reporting its channel",
    async (channel) => {
      const original = vi.mocked(coreJson).getMockImplementation()!;
      vi.mocked(coreJson).mockImplementation(async (path, init) => {
        if (path === "/api/system/update") {
          return { version: channel, channel, update: null };
        }
        if (path === "/api/system/update/versions") {
          return { channel, versions: [{ version: channel }] };
        }
        return original(path, init);
      });
      await render();
      await report({ state: "online", version: channel });
      await openSettings();

      expect(button("Update", system())?.disabled).toBe(false);
      await act(async () => button("Update", system())!.click());
      await act(async () =>
        button("Update", document.querySelector('[role="dialog"]')!)!.click(),
      );
      expect(started).toEqual([{ version: channel }]);
    },
  );

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
    await openSettings();
    expect(system().querySelector('[role="alert"]')).not.toBeNull();

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
    await openSettings();
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

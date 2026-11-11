// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";
import { followHost } from "../src/auth/session";
import { currentCredential, setCredential } from "../src/core-fetch";
import { setCoreBaseUrl } from "../src/core-url";
import { notAnsweringAfterMs } from "../src/connection-veil";
import type { CoreStatus } from "../src/core-status";
import type { FoundHost, Shell, StoredHost } from "../src/shell";

// The host never answers as itself until a test says so. Its core answers
// its health check until a test reports otherwise.
const core = vi.hoisted(() => ({ report: (_status: CoreStatus) => {} }));
vi.mock("../src/auth/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/auth/session")>()),
  followHost: vi.fn(),
}));
vi.mock("../src/core-status", () => ({
  startCoreStatusPolling: (onStatus: (status: CoreStatus) => void) => {
    core.report = onStatus;
    onStatus({ state: "online", version: "dev" });
    return { stop() {}, checkNow() {} };
  },
}));
vi.mock("../src/live", () => ({
  connectLive: () => ({ stop() {}, retryNow() {} }),
}));

const host: StoredHost = {
  hostId: "home-id",
  homeId: "home",
  name: "Maya's home",
  url: "http://192.168.1.20:4100",
  clientId: "c1",
  token: "client_saved",
  kind: "personal",
  pin: null,
};

let root: Root;
let container: HTMLDivElement;
let answer: (url: string) => void | Promise<void>;
let certificateFailed: (url: string, failure: "changed") => void;
let publish: (hosts: FoundHost[]) => void;
let forget: ReturnType<typeof vi.fn<(token: string) => Promise<void>>>;
let fetch: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  // Nothing in these tests may reach the core but the host answering.
  fetch = vi.fn(() => new Promise<Response>(() => {}));
  vi.stubGlobal("fetch", fetch);
  forget = vi.fn(async () => {});
  vi.stubGlobal("sanctumShell", {
    platform: "macos",
    deviceName: async () => "Mac",
    discovery: {
      watch: (onHosts) => {
        publish = onHosts;
        onHosts([]);
        return () => {};
      },
    },
    credentials: {
      isSecure: async () => true,
      load: async () => host,
      save: async () => {},
      forget,
    },
    trust: null,
    preferences: { get: async () => null, set: async () => {} },
  } satisfies Shell);
  vi.mocked(followHost).mockImplementation((_host, onFound, onCertificate) => {
    answer = onFound;
    certificateFailed = onCertificate!;
    return () => {};
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<App />));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
  setCredential(null);
  setCoreBaseUrl(null);
});

async function wait(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function button(name: string) {
  return [...document.querySelectorAll("button")].find(
    (candidate) => candidate.textContent === name,
  );
}

async function click(name: string) {
  await act(async () => {
    button(name)!.click();
    await vi.advanceTimersByTimeAsync(0);
  });
}

const dialog = () => document.querySelector('[role="dialog"]');
const veil = () => container.querySelector(".veil");
const isInert = (selector = "main") =>
  !!container.querySelector(selector)!.closest("[inert]");

describe("a home restored onto another host", () => {
  it("is checked on the host discovery finds it on, even after its old address failed", async () => {
    const check = vi.fn(async () => {});
    (window.sanctumShell as Shell).trust = {
      check,
      candidate: async () => null,
      failure: async () => null,
      resumed: async () => null,
    };
    // The old address answers with another CA before discovery lists the
    // restored host.
    await act(async () => certificateFailed(host.url, "changed"));
    expect(container.textContent).toContain(
      "This home's security certificate changed",
    );
    await act(async () =>
      publish([
        {
          id: "another-home-on-the-network",
          homeId: "elsewhere",
          name: "Cabin",
          claimed: true,
          url: "http://192.168.1.30:4100",
        },
        {
          id: "restored-host",
          homeId: host.homeId,
          name: "Sanctum",
          claimed: true,
          url: host.url,
        },
      ]),
    );

    await click("Sign in again");

    expect(check).toHaveBeenLastCalledWith(
      "restored-host",
      expect.objectContaining({ name: "sign-in" }),
    );
  });
});

describe("a stored home that does not answer", () => {
  it("shows an update before the host can answer its identity check", async () => {
    // While updatePending is set, the core serves only /api/health.
    await report({ state: "updating", version: "dev-2" });
    await wait(notAnsweringAfterMs.away);
    expect(veil()?.textContent).toContain("Updating");
    expect(button("Choose another home")).toBeUndefined();

    // A rollback can restart the core before identity checks are available.
    await report(offline);
    await wait(notAnsweringAfterMs.away - 1);
    expect(veil()?.textContent).toContain("Reconnecting");
    expect(button("Choose another home")).toBeUndefined();
    await wait(1);
    expect(button("Choose another home")).toBeDefined();

    // A health response alone must not expose the page before identity is checked.
    await report({ state: "online", version: "dev-2" });
    expect(veil()?.textContent).toContain("Connecting");
    expect(isInert()).toBe(true);
    await act(async () => answer(host.url));
    expect(veil()).toBeNull();
  });

  it("returns keyboard focus to the way out when its confirmation is cancelled", async () => {
    await wait(notAnsweringAfterMs.connecting);
    button("Choose another home")!.focus();
    await click("Choose another home");
    await click("Cancel");

    expect(document.activeElement).toBe(button("Choose another home"));
    expect(forget).not.toHaveBeenCalled();
  });

  it("covers the page while connecting, and says it is not answering only after a while", async () => {
    expect(veil()?.textContent).toBe("ConnectingLooking for your home.");
    expect(isInert()).toBe(true);

    await wait(notAnsweringAfterMs.connecting - 1);
    expect(veil()?.textContent).toBe("ConnectingLooking for your home.");
    expect(button("Choose another home")).toBeUndefined();

    await wait(1);
    expect(veil()?.textContent).toContain("Your home is not answering");
    expect(veil()?.textContent).toContain("Still looking for Maya's home.");
    expect(button("Choose another home")).toBeDefined();
    expect(isInert()).toBe(true);
    // It goes on looking.
    expect(followHost).toHaveBeenCalledTimes(1);
  });

  it("clears the message when the home answers, and forgets nothing", async () => {
    await wait(notAnsweringAfterMs.connecting);
    await click("Choose another home");
    expect(dialog()?.textContent).toContain("Forget this home?");

    await act(async () => answer(host.url));

    expect(veil()).toBeNull();
    expect(isInert()).toBe(false);
    expect(dialog()).toBeNull();
    expect(forget).not.toHaveBeenCalled();
    expect(currentCredential()).toEqual({
      url: host.url,
      token: host.token,
      pin: null,
    });
  });

  it("forgets it after a confirmation and returns to the host list without asking the core", async () => {
    await wait(notAnsweringAfterMs.connecting);
    await click("Choose another home");
    expect(dialog()?.textContent).toContain(
      "Maya's home cannot be reached to sign this device out, so the device stays listed in that home's Settings → Clients",
    );
    await click("Cancel");
    expect(dialog()).toBeNull();
    expect(forget).not.toHaveBeenCalled();

    await click("Choose another home");
    await click("Forget");

    expect(forget).toHaveBeenCalledWith(host.token);
    expect(currentCredential()).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Choose your home");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("keeps the token when forgetting fails, so cancelling can still reconnect", async () => {
    forget.mockRejectedValueOnce(new Error("Storage unavailable"));
    await wait(notAnsweringAfterMs.connecting);
    await click("Choose another home");
    await click("Forget");

    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "That did not work. Try again.",
    );
    expect(button("Forget")?.disabled).toBe(false);
    expect(currentCredential()).toEqual({
      url: host.url,
      token: host.token,
      pin: null,
    });

    await click("Cancel");
    await act(async () => answer(host.url));
    expect(veil()).toBeNull();
    expect(currentCredential()).toEqual({
      url: host.url,
      token: host.token,
      pin: null,
    });
  });

  it("can retry forgetting after storage fails", async () => {
    forget.mockRejectedValueOnce(new Error("Storage unavailable"));
    await wait(notAnsweringAfterMs.connecting);
    await click("Choose another home");
    await click("Forget");
    await click("Forget");

    expect(forget).toHaveBeenCalledTimes(2);
    expect(currentCredential()).toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Choose your home");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("stops calling the home unanswered once the host has answered as itself", async () => {
    await report(offline);
    await wait(notAnsweringAfterMs.connecting);
    expect(button("Choose another home")).toBeDefined();

    // The host answered, but its core's health check not yet.
    await act(async () => answer(host.url));
    expect(veil()?.textContent).toBe("ConnectingLooking for your home.");
    await wait(notAnsweringAfterMs.away);
    expect(button("Choose another home")).toBeUndefined();

    await report({ state: "online", version: "dev" });
    expect(veil()).toBeNull();
  });

  it("keeps the confirmation open until forgetting is done", async () => {
    let finish!: () => void;
    forget.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await wait(notAnsweringAfterMs.connecting);
    await click("Choose another home");
    await click("Forget");

    expect(button("Cancel")?.disabled).toBe(true);
    await act(async () => {
      dialog()!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
    });
    expect(dialog()).not.toBeNull();

    await act(async () => finish());
    expect(container.querySelector("h1")?.textContent).toBe("Choose your home");
  });

  it("refuses a move while forgetting, and takes it once forgetting failed", async () => {
    let fail!: (error: Error) => void;
    forget.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          fail = reject;
        }),
    );
    await wait(notAnsweringAfterMs.connecting);
    await click("Choose another home");
    await click("Forget");

    const movedUrl = "http://192.168.1.21:4100";
    // A refused move rejects, so followHost tries that address again later
    // (test/session.test.ts) rather than taking it as done.
    await act(async () => {
      await expect(answer(movedUrl)).rejects.toThrow();
    });
    await act(async () => fail(new Error("Storage unavailable")));
    await click("Cancel");
    // followHost's next try moves the host, and following the moved host finds
    // it there.
    await act(async () => answer(movedUrl));
    await act(async () => answer(movedUrl));

    expect(veil()).toBeNull();
    expect(currentCredential()).toEqual({
      url: movedUrl,
      token: host.token,
      pin: null,
    });
  });
});

async function connect() {
  await act(async () => answer(host.url));
  expect(veil()).toBeNull();
}

async function report(status: CoreStatus) {
  await act(async () => {
    core.report(status);
    await vi.advanceTimersByTimeAsync(0);
  });
}

const offline: CoreStatus = { state: "offline" };

describe("a connected home that does not come back", () => {
  it("covers the whole screen while away, and offers a way out only after a long while", async () => {
    await connect();
    expect(isInert("aside.sidebar-column nav")).toBe(false);

    await report(offline);
    expect(veil()?.textContent).toContain("Reconnecting");
    // The top bar and the sidebar are under the veil too.
    expect(isInert("header")).toBe(true);
    expect(isInert()).toBe(true);
    expect(isInert("aside.sidebar-column nav")).toBe(true);
    expect(dialog()).toBeNull();

    await wait(notAnsweringAfterMs.away - 1);
    expect(button("Choose another home")).toBeUndefined();
    await wait(1);
    expect(veil()?.textContent).toContain("Your home is not answering");
    expect(button("Choose another home")).toBeDefined();
  });

  it("never offers it during an update, and counts afresh after each restart", async () => {
    await connect();
    await report(offline);
    await wait(notAnsweringAfterMs.away - 10_000);
    await report({ state: "updating", version: "dev-2" });
    await wait(notAnsweringAfterMs.away);
    expect(veil()?.textContent).toContain("Updating");
    expect(button("Choose another home")).toBeUndefined();

    // A rollback restarts the core again.
    await report(offline);
    await wait(notAnsweringAfterMs.away - 1);
    expect(veil()?.textContent).toContain("Reconnecting");
    expect(button("Choose another home")).toBeUndefined();
    await wait(1);
    expect(button("Choose another home")).toBeDefined();
  });

  it("lifts when the home comes back, and forgets nothing", async () => {
    await connect();
    await report(offline);
    await wait(notAnsweringAfterMs.away);
    await click("Choose another home");
    expect(dialog()?.textContent).toContain("Forget this home?");

    await report({ state: "online", version: "dev" });
    expect(veil()).toBeNull();
    expect(isInert("header")).toBe(false);
    expect(dialog()).toBeNull();
    expect(forget).not.toHaveBeenCalled();
    expect(currentCredential()).toEqual({
      url: host.url,
      token: host.token,
      pin: null,
    });
  });

  it("forgets it after a confirmation without asking the core", async () => {
    await connect();
    await report(offline);
    await wait(notAnsweringAfterMs.away);
    await click("Choose another home");
    const asked = fetch.mock.calls.length;
    await click("Forget");

    expect(forget).toHaveBeenCalledWith(host.token);
    expect(container.querySelector("h1")?.textContent).toBe("Choose your home");
    expect(fetch.mock.calls.length).toBe(asked);
  });
});

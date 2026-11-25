// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";

import { setCredential } from "../src/core-fetch";
import { setCoreBaseUrl } from "../src/core-url";
import { followEffects } from "../src/effects";
import { host } from "./home-shell-fixtures";
import {
  mockCoreJson,
  pushLiveState,
  refresh,
  remountHome,
} from "./home-shell-harness";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const requests = (path: string) =>
  mockCoreJson.mock.calls.filter(([called]) => called === path).length;

function visibility() {
  const state = vi.spyOn(document, "visibilityState", "get");
  return async (next: DocumentVisibilityState) => {
    state.mockReturnValue(next);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
  };
}

it.each(["focus", "visibility"] as const)(
  "refreshes once when %s is the first event on return",
  async (first) => {
    const show = visibility();
    await show("hidden");
    mockCoreJson.mockClear();
    vi.spyOn(performance, "now").mockReturnValue(200);

    if (first === "focus") {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      await refresh();
      await show("visible");
    } else {
      await show("visible");
      await refresh();
    }
    expect(requests("/api/auth/me")).toBe(1);
    expect(requests("/api/apps")).toBe(1);
    expect(requests("/api/devices")).toBe(1);

    await refresh();
    expect(requests("/api/auth/me")).toBe(2);
  },
);

it("checks the token while hidden if the live connection is down", async () => {
  vi.useFakeTimers();
  await remountHome();
  const show = visibility();
  await act(async () => pushLiveState("live"));
  await show("hidden");
  mockCoreJson.mockClear();

  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(requests("/api/auth/me")).toBe(0);

  await act(async () => pushLiveState("offline"));
  await act(async () => vi.advanceTimersByTimeAsync(30_000));
  expect(requests("/api/auth/me")).toBe(1);
  expect(requests("/api/apps")).toBe(0);
  expect(requests("/api/devices")).toBe(0);
});

it("applies drawing choices from live notices without refreshing apps", async () => {
  let receive!: (data: object) => void;
  vi.stubGlobal(
    "WebSocket",
    class {
      onmessage?: (event: MessageEvent) => void;
      constructor() {
        receive = (data) =>
          this.onmessage?.(
            new MessageEvent("message", { data: JSON.stringify(data) }),
          );
      }
      close() {}
    },
  );
  setCredential(host);
  setCoreBaseUrl(host.url);
  const stopEffects = followEffects();
  try {
    const live =
      await vi.importActual<typeof import("../src/live")>("../src/live");
    const { connectLive } = await import("../src/live");
    vi.mocked(connectLive).mockImplementationOnce(live.connectLive);
    const original = mockCoreJson.getMockImplementation()!;
    let me = {
      client: {
        id: host.clientId,
        reduceEffects: "automatic",
        reduceMotion: "off",
        drawingRevision: 0,
      },
      person: null,
    };
    mockCoreJson.mockImplementation((path, init) =>
      path === "/api/auth/me"
        ? Promise.resolve(me)
        : path === "/api/auth/me/drawn"
          ? Promise.resolve(undefined)
          : original(path, init),
    );
    await remountHome();
    expect(document.documentElement.dataset.motion).toBeUndefined();
    mockCoreJson.mockClear();

    let finishFirst!: (value: typeof me) => void;
    const first = new Promise<typeof me>((resolve) => {
      finishFirst = resolve;
    });
    mockCoreJson.mockReturnValueOnce(first);
    await act(async () => {
      receive({ type: "client" });
      receive({ type: "client" });
      receive({ type: "client" });
    });
    expect(requests("/api/auth/me")).toBe(1);
    const previous = me;
    me = {
      ...me,
      client: { ...me.client, reduceMotion: "on", drawingRevision: 1 },
    };
    await act(async () => finishFirst(previous));

    expect(requests("/api/auth/me")).toBe(2);
    expect(requests("/api/apps")).toBe(0);
    expect(document.documentElement.dataset.motion).toBe("reduced");
  } finally {
    stopEffects();
    delete document.documentElement.dataset.motion;
    delete document.documentElement.dataset.effects;
    setCoreBaseUrl(null);
    setCredential(null);
  }
});

// @vitest-environment jsdom
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";

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

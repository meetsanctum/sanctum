// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { everyWhileShown, isShown, onShown } from "../src/while-shown";

// What asks the core again and again stops while the window is hidden and
// asks at once when it is shown again.

let visibility: DocumentVisibilityState = "visible";

function show(state: DocumentVisibilityState) {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("asks every interval while shown, nothing while hidden, and at once when shown again", () => {
  const ask = vi.fn();
  const stop = everyWhileShown(1_000, ask);

  vi.advanceTimersByTime(3_000);
  expect(ask).toHaveBeenCalledTimes(3);

  show("hidden");
  expect(isShown()).toBe(false);
  vi.advanceTimersByTime(10_000);
  expect(ask).toHaveBeenCalledTimes(3);

  show("visible");
  expect(ask).toHaveBeenCalledTimes(4);
  vi.advanceTimersByTime(1_000);
  expect(ask).toHaveBeenCalledTimes(5);

  stop();
  vi.advanceTimersByTime(5_000);
  show("hidden");
  show("visible");
  expect(ask).toHaveBeenCalledTimes(5);
});

it("starts paused in a window that is hidden", () => {
  show("hidden");
  const ask = vi.fn();
  const stop = everyWhileShown(1_000, ask);
  vi.advanceTimersByTime(5_000);
  expect(ask).not.toHaveBeenCalled();
  show("visible");
  expect(ask).toHaveBeenCalledTimes(1);
  stop();
});

it("says when the window is shown again, until stopped", () => {
  const shown = vi.fn();
  const stop = onShown(shown);
  show("hidden");
  expect(shown).not.toHaveBeenCalled();
  show("visible");
  expect(shown).toHaveBeenCalledTimes(1);
  stop();
  show("hidden");
  show("visible");
  expect(shown).toHaveBeenCalledTimes(1);
});

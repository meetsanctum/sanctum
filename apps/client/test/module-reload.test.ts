// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isFailedImport, reloadOnFailedImports } from "../src/module-reload";

const chromium = new TypeError(
  "Failed to fetch dynamically imported module: app://sanctum/assets/esm-old.js",
);

function preloadError(error: unknown) {
  const event = new Event("vite:preloadError", { cancelable: true });
  Object.assign(event, { payload: error });
  window.dispatchEvent(event);
  return event;
}

function rejection(reason: unknown) {
  const event = new Event("unhandledrejection", { cancelable: true });
  Object.assign(event, { reason });
  window.dispatchEvent(event);
  return event;
}

let stop: (() => void) | undefined;
let reload: ReturnType<typeof vi.fn<() => void>>;

function start(build = "app://sanctum/assets/index-a.js") {
  stop?.();
  stop = reloadOnFailedImports({ build, reload });
}

beforeEach(() => {
  sessionStorage.clear();
  reload = vi.fn<() => void>();
});

afterEach(() => {
  stop?.();
  stop = undefined;
});

describe("isFailedImport", () => {
  it("knows each engine's words for a module that did not load", () => {
    expect(isFailedImport(chromium)).toBe(true);
    expect(
      isFailedImport(new TypeError("Importing a module script failed.")),
    ).toBe(true);
    expect(
      isFailedImport(
        new TypeError("error loading dynamically imported module: x.js"),
      ),
    ).toBe(true);
    expect(isFailedImport(new Error("Failed to fetch"))).toBe(false);
    expect(isFailedImport(undefined)).toBe(false);
  });
});

describe("reloadOnFailedImports", () => {
  it("reloads once Vite says a chunk did not load, keeping the error back", () => {
    start();

    const event = preloadError(chromium);

    expect(reload).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("keeps module evaluation errors without reloading or hiding them", () => {
    start();
    const event = preloadError(new Error("Module initialization failed"));
    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("reloads when Vite cannot load a chunk's stylesheet", () => {
    start();
    preloadError(new Error("Unable to preload CSS for /assets/old.css"));
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads for an import the page left unhandled, and nothing else", () => {
    start();

    const other = rejection(new Error("The core said no"));
    expect(reload).not.toHaveBeenCalled();
    expect(other.defaultPrevented).toBe(false);

    rejection(chromium);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads for a render that failed on a module, which React reports", () => {
    start();

    const event = new ErrorEvent("error", {
      cancelable: true,
      error: new TypeError("Importing a module script failed."),
    });
    window.dispatchEvent(event);

    expect(reload).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it("reloads once for several chunks failing together", () => {
    start();

    const events = [preloadError(chromium), preloadError(chromium)];
    rejection(chromium);

    expect(reload).toHaveBeenCalledOnce();
    expect(events.every((event) => event.defaultPrevented)).toBe(true);
  });

  it("keeps the error when the same build fails again after its reload", () => {
    start();
    preloadError(chromium);
    // The reload brought back the same build.
    start();

    const event = preloadError(chromium);

    expect(reload).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(false);
  });

  it("reloads again once a newer build fails", () => {
    start("app://sanctum/assets/index-a.js");
    preloadError(chromium);
    start("app://sanctum/assets/index-b.js");

    preloadError(chromium);

    expect(reload).toHaveBeenCalledTimes(2);
  });

  it("never reloads where it cannot remember having done so", () => {
    stop = reloadOnFailedImports({
      build: "app://sanctum/assets/index-a.js",
      reload,
      storage: () => {
        throw new DOMException("denied", "SecurityError");
      },
    });

    const event = preloadError(chromium);

    expect(reload).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it("stops listening once stopped", () => {
    start();
    stop?.();

    preloadError(chromium);

    expect(reload).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";

import { createApartStarts } from "../src/app-host/apart-starts.js";
import type { ApartPackage } from "../src/app-host/host.js";
import type { InstalledApp } from "../src/app-host/installed.js";
import type { AppUpdates } from "../src/app-host/updates.js";

// A package swap can yield while the old socket closes. Removing the app or
// shutting down meanwhile must finish that cleanup without installing it again.
function swapping() {
  let finish!: () => void;
  const closing = new Promise<void>((done) => {
    finish = done;
  });
  const close = vi.fn(() => closing);
  const appId = "test.owner";
  const entry = {
    app: { id: appId },
    manifest: { id: appId },
    lifecycle: Promise.resolve(),
    storage: { close: vi.fn() },
    link: { close },
    supervision: { isEnded: false },
  } as unknown as InstalledApp;
  const installed = new Map([[appId, entry]]);
  const removals = new Map<string, Promise<void>>();
  const use = vi.fn<AppUpdates["use"]>();
  const install = vi.fn();
  const starts = createApartStarts({
    installed,
    removals,
    updates: { use, recover: async () => undefined } as unknown as AppUpdates,
    supervisor: {
      end: () => {
        entry.supervision!.isEnded = true;
      },
    } as never,
    install,
    stopApp: async () => undefined,
    announce: () => undefined,
    log: () => undefined,
  });
  const swap = () => use.mock.calls[0]![0].replace(entry, {} as ApartPackage);
  return { appId, starts, swap, close, finish, installed, removals, install };
}

describe("replacing a failed app's package", () => {
  it("starts only once when turning on overtakes startup recovery", async () => {
    let recover!: () => void;
    const recovered = new Promise<void>((done) => {
      recover = done;
    });
    const arrive = vi.fn();
    const listen = vi.fn(async () => undefined);
    const entry = {
      manifest: { id: "test.owner" },
      link: { listen },
      supervision: { isEnded: false },
    } as unknown as InstalledApp;
    const starts = createApartStarts({
      installed: new Map([[entry.manifest.id, entry]]),
      removals: new Map(),
      updates: {
        recover: () => recovered,
        arrive,
        use: () => undefined,
      } as unknown as AppUpdates,
      supervisor: {} as never,
      install: () => undefined,
      stopApp: async () => undefined,
      announce: () => undefined,
      log: () => undefined,
    });

    starts.start(entry);
    starts.start(entry);
    recover();
    await vi.waitFor(() => expect(arrive).toHaveBeenCalled());

    expect(listen).toHaveBeenCalledOnce();
    expect(arrive).toHaveBeenCalledOnce();
    await starts.close();
  });

  it("installs on the next try when installing fails part way", async () => {
    const { swap, finish, installed, install } = swapping();
    finish();
    install.mockImplementationOnce(() => {
      throw new Error("The grants can't be read");
    });

    await expect(swap()).rejects.toThrow("The grants can't be read");
    expect(installed.size).toBe(0);
    install.mockImplementationOnce((_pkg: unknown) => {
      installed.set("test.owner", {
        app: { id: "test.owner" },
        manifest: { id: "test.owner" },
        supervision: { isEnded: true },
      } as never);
    });
    await swap().catch(() => undefined);

    expect(install).toHaveBeenCalledTimes(2);
    expect(installed.size).toBe(1);
  });

  it("doesn't try again once the app has been removed meanwhile", async () => {
    const { appId, starts, swap, finish, install } = swapping();
    finish();
    install.mockImplementationOnce(() => {
      throw new Error("The grants can't be read");
    });
    await expect(swap()).rejects.toThrow("The grants can't be read");

    starts.cancel(appId);
    await swap();

    expect(install).toHaveBeenCalledTimes(1);
  });

  it("cancels a replacement removed while its old socket is closing", async () => {
    const home = swapping();
    const replacement = home.swap();
    await vi.waitFor(() => expect(home.close).toHaveBeenCalled());
    expect(home.removals.has(home.appId)).toBe(true);

    home.starts.cancel(home.appId);
    home.finish();
    await replacement;

    expect(home.install).not.toHaveBeenCalled();
    expect(home.installed.size).toBe(0);
    expect(home.removals.size).toBe(0);
  });

  it("waits for cleanup on shutdown and never reinstalls the app", async () => {
    const home = swapping();
    const replacement = home.swap();
    await vi.waitFor(() => expect(home.close).toHaveBeenCalled());
    const closed = vi.fn();

    const closing = home.starts.close().then(closed);
    await Promise.resolve();
    expect(closed).not.toHaveBeenCalled();
    home.finish();
    await Promise.all([replacement, closing]);

    expect(closed).toHaveBeenCalledOnce();
    expect(home.install).not.toHaveBeenCalled();
    expect(home.installed.size).toBe(0);
  });
});

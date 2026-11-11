import { NotReady } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import { useCleanUps } from "./app-apart-support.js";
import { appUpdates } from "../src/app-host/schema.js";
import { claimed, post } from "./support.js";
import { id, version, type Seen } from "./app-update-fixtures.js";
import {
  committedOf,
  rowOf,
  running,
  stateOf,
  versions,
} from "./app-update-support.js";

useCleanUps();

describe("a new version that isn't ready", () => {
  const waitsFor = (isReady: () => boolean, seen: Seen = []) =>
    version("2.0.0", {
      seen,
      start: async () => {
        if (!isReady()) throw new NotReady("Waiting for Zigbee2MQTT");
      },
    });

  it("gives the slot up: the old version comes back, its data as it was", async () => {
    const seen: Seen = [];
    const home = await versions();
    await running(await home.coreWith(version("1.0.0", { seen })), id);
    seen.length = 0;
    home.calls.length = 0;

    const core = await home.coreWith(waitsFor(() => false));

    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    expect(seen).toEqual([{ reason: "rolledBack", from: "2.0.0" }]);
    expect(home.calls.filter((each) => each.startsWith("UNDO"))).toEqual([
      `UNDO ${id}`,
    ]);
    await running(core, id);
    expect(stateOf(core, id).version).toBe("1.0.0");
    expect(rowOf(core)).toMatchObject({
      failure: null,
      retryAt: expect.any(Date),
    });
  });

  it("is tried again later, and takes over when it can", async () => {
    let isReady = false;
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);

    const core = await home.coreWith(
      waitsFor(() => isReady),
      { retryAfterMs: 30 },
    );
    await vi.waitFor(() => expect(home.calls).toContain(`UNDO ${id}`));
    isReady = true;

    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"));
    await running(core, id);
    expect(rowOf(core)).toBeUndefined();
    expect(stateOf(core, id).version).toBe("2.0.0");
  });

  it("goes back each time it still isn't, counting nothing against it", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);

    const core = await home.coreWith(
      waitsFor(() => false),
      { retryAfterMs: 20 },
    );

    await vi.waitFor(() =>
      expect(
        home.calls.filter((each) => each.startsWith("UNDO")).length,
      ).toBeGreaterThan(1),
    );
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    expect(rowOf(core)?.failure).toBeNull();
    expect(committedOf(core)?.version).toBe("1.0.0");
  });

  it("retries a package read that failed temporarily, without restarting the core", async () => {
    let isReady = false;
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const core = await home.coreWith(
      waitsFor(() => isReady),
      { retryAfterMs: 150 },
    );
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    home.packagesUnreadableFor(1);
    isReady = true;

    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"));
  });

  it("keeps the update record when a loaded retry is cancelled by removal", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    let isLoadingHeld = false;
    let release!: () => void;
    const loading = vi.fn(async () => {
      if (isLoadingHeld)
        await new Promise<void>((done) => {
          release = done;
        });
    });
    const core = await home.coreWith(
      waitsFor(() => false),
      {
        retryAfterMs: 150,
        beforeLoad: loading,
      },
    );
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    isLoadingHeld = true;
    loading.mockClear();
    await vi.waitFor(() => expect(loading).toHaveBeenCalled());
    const saved = rowOf(core);
    await core.apps.remove(id);

    release();
    await new Promise((done) => setTimeout(done, 30));

    expect(rowOf(core)).toEqual(saved);
    expect(core.apps.list()).toEqual([]);
  });

  it("finishes a retry whose replacement failed before it could install", async () => {
    let isReady = false;
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const core = await home.coreWith(
      waitsFor(() => isReady),
      { retryAfterMs: 150 },
    );
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    const reconcile = vi
      .spyOn(core.entities, "reconcileTypes")
      .mockImplementationOnce(() => {
        throw new Error("The installation was interrupted");
      });
    isReady = true;

    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"));
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(rowOf(core)).toBeUndefined();
  });

  it("leaves one that's off on its old version until it is turned back on", async () => {
    let isReady = false;
    const home = await versions();
    const before = await home.coreWith(version("1.0.0"));
    await running(before, id);
    const maya = await claimed(before);
    const core = await home.coreWith(
      waitsFor(() => isReady),
      { retryAfterMs: 150 },
    );
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("undone"));
    await post(core, `/api/apps/${id}/off`, { off: true }, maya);
    isReady = true;

    await new Promise((done) => setTimeout(done, 200));
    expect(stateOf(core, id)).toMatchObject({ state: "off", version: "1.0.0" });
    expect(rowOf(core)?.status).toBe("undone");

    await post(core, `/api/apps/${id}/off`, { off: false }, maya);
    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"));
  });

  it("stays on the old version across a restart, until it's time to try again", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const two = waitsFor(() => false);
    const first = await home.coreWith(two);
    await vi.waitFor(() => expect(rowOf(first)?.status).toBe("undone"));
    home.calls.length = 0;

    const core = await home.coreWith(two);
    await running(core, id);

    expect(stateOf(core, id).version).toBe("1.0.0");
    expect(home.calls.filter((each) => each.startsWith("BEGIN"))).toEqual([]);
  });

  it("is tried again at once by a core that starts after that time", async () => {
    let isReady = false;
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const two = waitsFor(() => isReady);
    const first = await home.coreWith(two);
    await vi.waitFor(() => expect(rowOf(first)?.status).toBe("undone"));
    first.db
      .update(appUpdates)
      .set({ retryAt: new Date(0) })
      .run();
    isReady = true;

    const core = await home.coreWith(two);

    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"));
  });
});

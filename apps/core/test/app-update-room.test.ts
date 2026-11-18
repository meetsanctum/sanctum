import { describe, expect, it, vi } from "vitest";

import { ManagerRefusal } from "../src/manager.js";
import { useCleanUps } from "./app-apart-support.js";
import { id, version } from "./app-update-fixtures.js";
import {
  committedOf,
  running,
  stateOf,
  versions,
} from "./app-update-support.js";

// An update that needs more memory than is left beside the other apps waits
// for room, the app on the version it has, and starts by itself once there's
// some, the manager holding it until its container starts.

useCleanUps();

// A manager that keeps one count, short of this much for the app.
function counting(home: Awaited<ReturnType<typeof versions>>) {
  const room = {
    shortMb: 0,
    reserved: [] as { app: string; memoryMb: number }[],
  };
  const before = home.manager.capabilities;
  Object.assign(home.manager, {
    capabilities: () => ({ ...before(), reserves: true }),
    reserveForApp: async (app: string, need: { memoryMb: number }) => {
      if (room.shortMb > 0) {
        throw new ManagerRefusal(`${app} needs more memory`, 409);
      }
      room.reserved.push({ app, memoryMb: need.memoryMb });
      return { id: "reservation-1", until: new Date().toISOString() };
    },
    appCapacity: async (apps: { app: string; memoryMb: number }[]) =>
      Object.fromEntries(
        apps.map(({ app, memoryMb }) => [
          app,
          {
            memoryNeedsMb: memoryMb,
            memoryFreeMb: memoryMb - room.shortMb,
            dataNeedsMb: 0,
            dataFreeBytes: null,
          },
        ]),
      ),
  });
  return room;
}

describe("an update short of memory", () => {
  it("waits for room, the app running the version it has", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const room = counting(home);
    room.shortMb = 64;
    home.calls.length = 0;

    const core = await home.coreWith(version("2.0.0"));
    await running(core, id);

    expect(stateOf(core, id)).toMatchObject({
      version: "1.0.0",
      waiting: { version: "2.0.0", needs: [], moreMemoryMb: 64 },
    });
    expect(home.calls.some((call) => call.startsWith("BEGIN"))).toBe(false);
    expect(committedOf(core)?.version).toBe("1.0.0");
  });

  it("starts by itself once there's room, held for it", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const room = counting(home);
    room.shortMb = 64;
    const core = await home.coreWith(version("2.0.0"));
    await running(core, id);

    room.shortMb = 0;
    await core.apps.retryRoomWaits();

    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"), {
      timeout: 4_000,
    });
    expect(room.reserved).toContainEqual({ app: id, memoryMb: 128 });
    expect(stateOf(core, id).waiting).toBeUndefined();
  });

  it("says how much more it needs while there still isn't room", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const room = counting(home);
    room.shortMb = 64;
    const core = await home.coreWith(version("2.0.0"));
    await running(core, id);

    room.shortMb = 32;
    await core.apps.retryRoomWaits();

    expect(stateOf(core, id)).toMatchObject({
      version: "1.0.0",
      waiting: { version: "2.0.0", moreMemoryMb: 32 },
    });
  });

  it("goes ahead with a manager that keeps no count, its start checking", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);

    const core = await home.coreWith(version("2.0.0"));

    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"), {
      timeout: 4_000,
    });
    expect(stateOf(core, id).waiting).toBeUndefined();
  });
});

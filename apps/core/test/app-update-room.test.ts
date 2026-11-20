import type { AppInfo } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import { ManagerRefusal, ManagerUnavailable } from "../src/manager.js";
import { useCleanUps } from "./app-apart-support.js";
import { id, version } from "./app-update-fixtures.js";
import {
  committedOf,
  running,
  stateOf,
  versions,
} from "./app-update-support.js";
import { openLive } from "./devices-support.js";
import { claimed, post, type TestCore } from "./support.js";

// An update that needs more memory than is left beside the other apps waits
// for room, the app on the version it has, and starts by itself once there's
// some, the manager holding it until its container starts.

useCleanUps();

// A manager that keeps one count, short of this much for the app.
function counting(home: Awaited<ReturnType<typeof versions>>) {
  const room = {
    shortMb: 0,
    reportedShortMb: undefined as number | undefined,
    isUnavailable: false,
    beforeReserve: async () => {},
    reserved: [] as { app: string; memoryMb: number; services: string[] }[],
    released: [] as string[],
  };
  const before = home.manager.capabilities;
  Object.assign(home.manager, {
    capabilities: () => ({ ...before(), reserves: true }),
    reserveForApp: async (
      app: string,
      need: { memoryMb: number; services: string[] },
    ) => {
      await room.beforeReserve();
      if (room.isUnavailable) throw new ManagerUnavailable("Try again");
      if (room.shortMb > 0) {
        throw new ManagerRefusal(`${app} needs more memory`, 409);
      }
      room.reserved.push({
        app,
        memoryMb: need.memoryMb,
        services: need.services,
      });
      return { id: "reservation-1", until: new Date().toISOString() };
    },
    appCapacity: async (apps: { app: string; memoryMb: number }[]) =>
      Object.fromEntries(
        apps.map(({ app, memoryMb }) => [
          app,
          {
            memoryNeedsMb: memoryMb,
            memoryFreeMb: memoryMb - (room.reportedShortMb ?? room.shortMb),
            dataNeedsMb: 0,
            dataFreeBytes: null,
          },
        ]),
      ),
    releaseAppReservation: async (_app: string, reservation: string) => {
      room.released.push(reservation);
    },
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
    expect(room.reserved).toContainEqual({
      app: id,
      memoryMb: 128,
      services: [],
    });
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

  it("keeps waiting when a reservation fails and the capacity reading has changed", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const room = counting(home);
    room.shortMb = 64;
    const core = await home.coreWith(version("2.0.0"));
    await running(core, id);

    room.reportedShortMb = 0;
    await core.apps.retryRoomWaits();

    expect(stateOf(core, id)).toMatchObject({
      version: "1.0.0",
      waiting: { version: "2.0.0", moreMemoryMb: 64 },
    });
    expect(room.reserved).toEqual([]);
  });

  it("keeps a known wait when the manager can't answer, even across a restart", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const room = counting(home);
    room.shortMb = 64;
    const two = version("2.0.0");
    const core = await home.coreWith(two);
    await running(core, id);
    const waiting = stateOf(core, id).waiting;

    room.isUnavailable = true;
    await core.apps.retryRoomWaits();
    expect(stateOf(core, id).waiting).toEqual(waiting);

    const again = await home.coreWith(two);
    await running(again, id);
    expect(stateOf(again, id).waiting).toEqual(waiting);
    expect(committedOf(again)?.version).toBe("1.0.0");
  });

  it("refuses a permission approval for a wait for memory", async () => {
    const home = await versions();
    const before = await home.coreWith(version("1.0.0"));
    await running(before, id);
    const owner = await claimed(before);
    const room = counting(home);
    room.shortMb = 64;
    const core = await home.coreWith(version("2.0.0"));
    await running(core, id);
    const waiting = stateOf(core, id).waiting!;

    const answer = await post(
      core,
      `/api/apps/${id}/update/allow`,
      { id: waiting.id },
      owner,
    );

    expect(answer.statusCode).toBe(409);
    expect(stateOf(core, id).waiting).toEqual(waiting);
  });

  it("waits for a permission that was revoked while waiting for memory", async () => {
    const home = await versions();
    const permission = {
      id: "people.read",
      reason: "To know who's home.",
      needed: true,
    };
    const before = await home.coreWith(
      version("1.0.0", {
        permissions: [{ ...permission, needed: false, startsOn: true }],
      }),
      { allowed: false },
    );
    await running(before, id);
    const owner = await claimed(before);
    const room = counting(home);
    room.shortMb = 64;
    const core = await home.coreWith(
      version("2.0.0", { permissions: [permission] }),
      { allowed: false },
    );
    await running(core, id);
    const waiting = stateOf(core, id).waiting!;
    expect(waiting.moreMemoryMb).toBe(64);

    const answer = await post(
      core,
      `/api/apps/${id}/permissions/update`,
      { permission: permission.id, granted: false },
      owner,
    );
    expect(answer.statusCode).toBe(200);
    room.shortMb = 0;
    await core.apps.retryRoomWaits();

    const current = stateOf(core, id);
    expect(current.version).toBe("1.0.0");
    expect(current.waiting?.id).not.toBe(waiting.id);
    expect(current.waiting?.needs).toMatchObject([permission]);
    expect(current.waiting?.moreMemoryMb).toBeUndefined();
    expect(room.reserved).toEqual([]);
  });

  it("releases the reservation and keeps the wait if the retry is cancelled", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const room = counting(home);
    room.shortMb = 64;
    const core = await home.coreWith(version("2.0.0"));
    await running(core, id);
    const waiting = stateOf(core, id).waiting;

    const cancelled = new AbortController();
    room.shortMb = 0;
    room.beforeReserve = async () => cancelled.abort();
    await core.apps.retryRoomWaits(cancelled.signal);

    expect(stateOf(core, id).waiting).toEqual(waiting);
    expect(room.released).toEqual(["reservation-1"]);
  });

  it("keeps a memory wait while its app is off, even across a restart", async () => {
    const home = await versions();
    const before = await home.coreWith(version("1.0.0"));
    await running(before, id);
    const owner = await claimed(before);
    const room = counting(home);
    room.shortMb = 64;
    const two = version("2.0.0");
    const core = await home.coreWith(two);
    await running(core, id);
    const waiting = stateOf(core, id).waiting;
    const turnOff = await post(
      core,
      `/api/apps/${id}/off`,
      { off: true },
      owner,
    );
    expect(turnOff.statusCode).toBe(200);

    room.shortMb = 0;
    await core.apps.retryRoomWaits();

    expect(stateOf(core, id)).toMatchObject({ state: "off", waiting });
    expect(room.reserved).toEqual([]);

    const again = await home.coreWith(two);
    expect(stateOf(again, id)).toMatchObject({ state: "off", waiting });
    expect(room.reserved).toEqual([]);

    const turnOn = await post(
      again,
      `/api/apps/${id}/off`,
      { off: false },
      owner,
    );
    expect(turnOn.statusCode).toBe(200);
    await running(again, id);
    await again.apps.retryRoomWaits();
    await vi.waitFor(() => expect(committedOf(again)?.version).toBe("2.0.0"), {
      timeout: 4_000,
    });
  });

  it("reserves no memory for a new optional service that starts off", async () => {
    const home = await versions();
    await running(
      await home.coreWith(version("1.0.0"), { allowed: false }),
      id,
    );
    const room = counting(home);
    const core = await home.coreWith(
      version("2.0.0", {
        permissions: [
          {
            id: "services:mosquitto",
            reason: "To talk to the broker.",
            needed: false,
            startsOn: true,
          },
        ],
      }),
      { allowed: false },
    );

    await running(core, id);
    expect(room.reserved).toEqual([{ app: id, memoryMb: 128, services: [] }]);
    expect(stateOf(core, id).permissions).not.toContain("services:mosquitto");
  });

  it("goes ahead once the manager keeps no count, as an older one doesn't", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const room = counting(home);
    room.shortMb = 64;
    const core = await home.coreWith(version("2.0.0"));
    await running(core, id);
    expect(stateOf(core, id).waiting?.moreMemoryMb).toBe(64);

    // A manager rolled back to one from before its count.
    const counts = home.manager.capabilities;
    home.manager.capabilities = () => ({ ...counts(), reserves: false });
    await core.apps.retryRoomWaits();

    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"), {
      timeout: 4_000,
    });
    expect(stateOf(core, id).waiting).toBeUndefined();
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

describe("allowing an update", () => {
  const people = {
    id: "people.read",
    reason: "To know who's home.",
    needed: true,
  };
  const broker = {
    id: "services:mosquitto",
    reason: "To talk to the broker.",
    needed: true,
  };

  const allowing = (core: TestCore) =>
    core.activity.recent().filter((entry) => entry.action === "allow-update");

  it("is granted and waits for room, the app on the version it has", async () => {
    const home = await versions();
    const before = await home.coreWith(version("1.0.0"), { allowed: false });
    await running(before, id);
    const owner = await claimed(before);
    const room = counting(home);
    const core = await home.coreWith(
      version("2.0.0", { permissions: [broker] }),
      { allowed: false },
    );
    await running(core, id);
    const waiting = stateOf(core, id).waiting!;
    expect(waiting.needs).toMatchObject([broker]);
    room.shortMb = 64;
    home.calls.length = 0;

    const answer = await post(
      core,
      `/api/apps/${id}/update/allow`,
      { id: waiting.id },
      owner,
    );

    expect(answer.statusCode).toBe(200);
    const current = stateOf(core, id);
    expect(current.version).toBe("1.0.0");
    expect(current.waiting).toMatchObject({
      version: "2.0.0",
      needs: [],
      moreMemoryMb: 64,
    });
    expect(current.waiting?.id).not.toBe(waiting.id);
    expect(home.calls.some((call) => call.startsWith("BEGIN"))).toBe(false);
    expect(committedOf(core)?.version).toBe("1.0.0");
    expect(allowing(core)).toMatchObject([{ outcome: "ok" }]);

    room.shortMb = 0;
    await core.apps.retryRoomWaits();

    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"), {
      timeout: 4_000,
    });
    expect(room.reserved).toContainEqual({
      app: id,
      memoryMb: 128,
      services: ["mosquitto"],
    });
    expect(stateOf(core, id).waiting).toBeUndefined();
  });

  it("grants the version that runs what it also asks for", async () => {
    const home = await versions();
    const optional = { ...people, needed: false, startsOn: false };
    const before = await home.coreWith(
      version("1.0.0", { permissions: [optional] }),
      { allowed: false },
    );
    await running(before, id);
    const owner = await claimed(before);
    expect(stateOf(before, id).permissions).toEqual([]);
    const room = counting(home);
    const core = await home.coreWith(
      version("2.0.0", { permissions: [people] }),
      { allowed: false },
    );
    await running(core, id);
    const waiting = stateOf(core, id).waiting!;
    room.shortMb = 64;
    const live = await openLive(core, owner.token);

    const answer = await post(
      core,
      `/api/apps/${id}/update/allow`,
      { id: waiting.id },
      owner,
    );

    expect(answer.statusCode).toBe(200);
    expect(stateOf(core, id)).toMatchObject({
      version: "1.0.0",
      permissions: ["people.read"],
      waiting: { needs: [], moreMemoryMb: 64 },
    });
    await vi.waitFor(() =>
      expect(
        live.messages
          .filter((message) => message.type === "app")
          .map(({ app }) => app as AppInfo)
          .find((app) => app.waiting?.moreMemoryMb === 64),
      ).toMatchObject({ permissions: ["people.read"] }),
    );
  });

  it("starts with room held for it and the services it grants", async () => {
    const home = await versions();
    const before = await home.coreWith(version("1.0.0"), { allowed: false });
    await running(before, id);
    const owner = await claimed(before);
    const room = counting(home);
    const core = await home.coreWith(
      version("2.0.0", { permissions: [broker] }),
      { allowed: false },
    );
    await running(core, id);
    const waiting = stateOf(core, id).waiting!;

    const answer = await post(
      core,
      `/api/apps/${id}/update/allow`,
      { id: waiting.id },
      owner,
    );

    expect(answer.statusCode).toBe(200);
    expect(room.reserved).toEqual([
      { app: id, memoryMb: 128, services: ["mosquitto"] },
    ]);
    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"), {
      timeout: 4_000,
    });
    expect(room.released).toEqual([]);
    expect(stateOf(core, id).waiting).toBeUndefined();
  });

  it("rechecks room if a service permission changes during the reservation", async () => {
    const home = await versions();
    const optional = { ...broker, needed: false };
    const before = await home.coreWith(
      version("1.0.0", { permissions: [optional] }),
      { allowed: false },
    );
    await running(before, id);
    const owner = await claimed(before);
    const room = counting(home);
    const core = await home.coreWith(
      version("2.0.0", { permissions: [optional, people] }),
      { allowed: false },
    );
    await running(core, id);
    const waiting = stateOf(core, id).waiting!;
    room.beforeReserve = async () => {
      room.beforeReserve = async () => {};
      const grant = await post(
        core,
        `/api/apps/${id}/permissions/update`,
        { permission: broker.id, granted: true },
        owner,
      );
      expect(grant.statusCode).toBe(200);
    };

    const allow = () =>
      post(core, `/api/apps/${id}/update/allow`, { id: waiting.id }, owner);

    expect((await allow()).statusCode).toBe(409);
    expect(room.released).toEqual(["reservation-1"]);
    expect(stateOf(core, id)).toMatchObject({
      version: "1.0.0",
      permissions: [broker.id],
      waiting,
    });
    expect((await allow()).statusCode).toBe(200);
    expect(room.reserved.map(({ services }) => services)).toEqual([
      [],
      ["mosquitto"],
    ]);
    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"), {
      timeout: 4_000,
    });
  });

  it.each([
    { change: "turns off", turnsBackOn: false },
    { change: "turns off and back on", turnsBackOn: true },
  ])(
    "releases the reservation if the app $change during the check",
    async ({ turnsBackOn }) => {
      const home = await versions();
      const before = await home.coreWith(version("1.0.0"), { allowed: false });
      await running(before, id);
      const owner = await claimed(before);
      const room = counting(home);
      const core = await home.coreWith(
        version("2.0.0", { permissions: [people] }),
        { allowed: false },
      );
      await running(core, id);
      const waiting = stateOf(core, id).waiting!;
      room.beforeReserve = async () => {
        room.beforeReserve = async () => {};
        const off = await post(
          core,
          `/api/apps/${id}/off`,
          { off: true },
          owner,
        );
        expect(off.statusCode).toBe(200);
        if (turnsBackOn) {
          const on = await post(
            core,
            `/api/apps/${id}/off`,
            { off: false },
            owner,
          );
          expect(on.statusCode).toBe(200);
        }
      };

      const allow = () =>
        post(core, `/api/apps/${id}/update/allow`, { id: waiting.id }, owner);

      expect((await allow()).statusCode).toBe(409);
      expect(room.released).toEqual(["reservation-1"]);
      expect(stateOf(core, id)).toMatchObject({
        version: "1.0.0",
        waiting,
      });
      // Allow answers a conflict until a Turn on still under way ends.
      await vi.waitFor(async () =>
        expect((await allow()).statusCode).toBe(200),
      );
      // Only the update's own is left, for its start: none while it's off.
      expect(room.reserved.length - room.released.length).toBe(
        turnsBackOn ? 1 : 0,
      );
      await vi.waitFor(() =>
        expect(stateOf(core, id)).toMatchObject({
          state: turnsBackOn ? "running" : "off",
          version: "2.0.0",
        }),
      );
    },
  );

  it("releases the reservation if a Turn on still under way ends during the check", async () => {
    const home = await versions();
    const before = await home.coreWith(version("1.0.0"), { allowed: false });
    await running(before, id);
    const owner = await claimed(before);
    const room = counting(home);
    const core = await home.coreWith(
      version("2.0.0", { permissions: [people] }),
      { allowed: false },
    );
    await running(core, id);
    const waiting = stateOf(core, id).waiting!;
    const turn = (off: boolean) =>
      post(core, `/api/apps/${id}/off`, { off }, owner);
    expect((await turn(true)).statusCode).toBe(200);
    await vi.waitFor(() => expect(stateOf(core, id).state).toBe("off"));
    room.beforeReserve = async () => {
      room.beforeReserve = async () => {};
      await running(core, id);
    };

    const allow = () =>
      post(core, `/api/apps/${id}/update/allow`, { id: waiting.id }, owner);
    const [on, allowed] = await Promise.all([turn(false), allow()]);

    expect(on.statusCode).toBe(200);
    expect(allowed.statusCode).toBe(409);
    expect(room.released).toEqual(["reservation-1"]);
    expect(stateOf(core, id)).toMatchObject({ version: "1.0.0", waiting });
    await vi.waitFor(async () => expect((await allow()).statusCode).toBe(200));
    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"), {
      timeout: 4_000,
    });
  });

  it("starts as before when the manager can't answer", async () => {
    const home = await versions();
    const before = await home.coreWith(version("1.0.0"), { allowed: false });
    await running(before, id);
    const owner = await claimed(before);
    const room = counting(home);
    const core = await home.coreWith(
      version("2.0.0", { permissions: [broker] }),
      { allowed: false },
    );
    await running(core, id);
    const waiting = stateOf(core, id).waiting!;
    room.isUnavailable = true;

    const answer = await post(
      core,
      `/api/apps/${id}/update/allow`,
      { id: waiting.id },
      owner,
    );

    expect(answer.statusCode).toBe(200);
    await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"), {
      timeout: 4_000,
    });
    expect(room.reserved).toEqual([]);
  });
});

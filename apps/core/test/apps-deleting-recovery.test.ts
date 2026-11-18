import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createAddedApps } from "../src/app-host/added.js";
import { createAppDeleting } from "../src/app-host/deleting.js";
import type { Gate } from "../src/app-host/gate.js";
import { createListTurns } from "../src/app-host/list-turns.js";
import { createRemovedApps, keptForMs } from "../src/app-host/removed.js";
import { appGrants } from "../src/app-host/schema.js";
import type { Principal } from "../src/auth/clients.js";
import { openCoreDatabase } from "../src/database.js";
import { ManagerRefusal, ManagerUnavailable } from "../src/manager.js";
import { updatePendingFile } from "../src/update-pending.js";
import { fakeManager } from "./manager-support.js";
import { testCore } from "./support.js";

const appId = "sanctum.example";
const someone = { client: { id: "client-1" } } as Principal;

async function setup() {
  const folder = await mkdtemp(join(tmpdir(), "sanctum-delete-recovery-"));
  const open = openCoreDatabase(folder);
  onTestFinished(async () => {
    open.close();
    await rm(folder, { recursive: true, force: true });
  });
  let at = new Date("2026-11-17T12:00:00Z");
  const now = () => at;
  const { db } = open;
  const removed = createRemovedApps(db, { now });
  const turns = createListTurns();
  const manager = {
    capabilities: () => fakeManager().manager.capabilities(),
    deleteAppData: vi.fn(async (_app: string): Promise<void> => undefined),
    eraseServiceData: vi.fn(
      async (_service: string): Promise<void> => undefined,
    ),
  };
  const record = (id = appId, isDone = true) => {
    removed.record(id, {}, { name: "Example", version: "1.0.0" });
    if (isDone) removed.done(id);
  };
  const finishRemoval = vi.fn(async (id: string) => removed.done(id));
  const log = vi.fn();
  const start = (
    overrides: Partial<Parameters<typeof createAppDeleting>[0]> = {},
  ) =>
    createAppDeleting({
      db,
      gate: { admit: () => undefined } as unknown as Gate,
      turns,
      removed,
      added: createAddedApps(db, { now }),
      activity: { for: () => () => "entry" },
      manager,
      entities: { removeApp: () => undefined },
      finishRemoval,
      now,
      log,
      ...overrides,
    });
  record();
  return {
    db,
    removed,
    turns,
    manager,
    record,
    finishRemoval,
    log,
    start,
    advance: (ms: number) => (at = new Date(at.getTime() + ms)),
  };
}

describe("deletion deadlines and recovery", () => {
  it("checks the removal date after earlier changes to the home's list finish", async () => {
    const home = await setup();
    home.advance(keptForMs);
    // An add and another removal already queued before the deadline check.
    const changed = home.turns.take(async () => home.record());
    await home.start().expire();
    await changed;

    expect(home.manager.deleteAppData).not.toHaveBeenCalled();
    expect(home.removed.get(appId)).toBeDefined();
  });

  it("waits for every deletion in a sweep before the app changes have settled", async () => {
    const home = await setup();
    home.record("sanctum.other");
    home.advance(keptForMs);
    let finishFirst!: () => void;
    let finishSecond!: () => void;
    const first = new Promise<void>((resolve) => (finishFirst = resolve));
    const second = new Promise<void>((resolve) => (finishSecond = resolve));
    home.manager.deleteAppData
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);

    const expiring = home.start().expire();
    await vi.waitFor(() =>
      expect(home.manager.deleteAppData).toHaveBeenCalledTimes(1),
    );
    let isSettled = false;
    const settled = home.turns.settled().then(() => (isSettled = true));
    finishFirst();
    await vi.waitFor(() =>
      expect(home.manager.deleteAppData).toHaveBeenCalledTimes(2),
    );
    const settledBeforeSecond = isSettled;
    finishSecond();
    await Promise.all([expiring, settled]);

    expect(settledBeforeSecond).toBe(false);
  });

  it("finishes a removal a failed step left part way, then deletes its data", async () => {
    const home = await setup();
    home.record(appId, false);
    home.advance(keptForMs);

    await home.start().expire();

    expect(home.finishRemoval).toHaveBeenCalledWith(appId);
    expect(home.manager.deleteAppData).toHaveBeenCalledWith(appId);
    expect(home.removed.get(appId)).toBeUndefined();
  });

  it("keeps a removal that still can't finish for the next check", async () => {
    const home = await setup();
    home.record(appId, false);
    home.advance(keptForMs);
    home.finishRemoval.mockRejectedValueOnce(
      new ManagerUnavailable("No answer"),
    );

    await home.start().expire();

    expect(home.manager.deleteAppData).not.toHaveBeenCalled();
    expect(home.removed.get(appId)).toMatchObject({
      isDone: false,
      isDeleting: false,
    });
  });

  it("stops between apps once the core is stopping", async () => {
    const home = await setup();
    home.record("sanctum.other");
    home.advance(keptForMs);
    let finishFirst!: () => void;
    home.manager.deleteAppData.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishFirst = resolve)),
    );
    const deleting = home.start();

    const expiring = deleting.expire();
    await vi.waitFor(() =>
      expect(home.manager.deleteAppData).toHaveBeenCalledTimes(1),
    );
    deleting.close();
    finishFirst();
    await expiring;

    expect(home.manager.deleteAppData).toHaveBeenCalledTimes(1);
    expect(home.removed.list()).toHaveLength(1);
  });

  it("logs a check that fails as a whole, and keeps checking", async () => {
    const home = await setup();
    const deleting = home.start({
      removed: {
        ...home.removed,
        list: () => {
          throw new Error("disk I/O error");
        },
      },
    });

    deleting.start();
    onTestFinished(() => deleting.close());

    await vi.waitFor(() =>
      expect(home.log).toHaveBeenCalledWith(
        "apps: removed apps' deadlines weren't checked (disk I/O error)",
      ),
    );
  });

  it("resumes a failed Delete now before its original deadline", async () => {
    const home = await setup();
    home.db
      .insert(appGrants)
      .values({
        appId,
        permission: "services:zigbee2mqtt",
        granted: true,
        updatedAt: new Date(),
      })
      .run();
    home.manager.eraseServiceData.mockRejectedValueOnce(
      new ManagerUnavailable("The manager did not answer"),
    );

    await expect(home.start().deleteNow(someone, appId)).rejects.toThrow();
    expect(home.manager.deleteAppData).toHaveBeenCalledTimes(1);
    expect(home.removed.get(appId)?.isDeleting).toBe(true);

    await home.start().expire();

    expect(home.manager.deleteAppData).toHaveBeenCalledTimes(2);
    expect(home.manager.eraseServiceData).toHaveBeenCalledTimes(2);
    expect(home.removed.get(appId)).toBeUndefined();
  });

  it.each([
    [new ManagerRefusal("Busy", 409), "conflict"],
    [new ManagerUnavailable("No answer"), "unavailable"],
    [new ManagerRefusal("Unknown call", 404), "unavailable"],
  ])("maps %s to the app API's %s response", async (error, code) => {
    const home = await setup();
    home.manager.deleteAppData.mockRejectedValueOnce(error);

    await expect(home.start().deleteNow(someone, appId)).rejects.toMatchObject({
      code,
    });
    expect(home.removed.get(appId)).toBeDefined();
  });

  it("starts expiry after the core's trial commits", async () => {
    const { manager, deleted } = fakeManager();
    const before = await testCore({ manager });
    before.removedApps.record(appId, {}, { name: "Example", version: "1.0.0" });
    before.removedApps.done(appId);
    await before.stop();

    const trial = await testCore({
      manager,
      dataDir: before.dataDir,
      onTrial: true,
      startsAt: "2026-12-01T12:00:00Z",
    });
    expect(deleted).toEqual([]);

    await rm(join(trial.dataDir, updatePendingFile));
    await vi.waitFor(() => expect(deleted).toEqual([`data ${appId}`]), {
      timeout: 2_000,
    });
  });
});

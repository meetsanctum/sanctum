import { eq } from "drizzle-orm";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { loadHomeId } from "../src/places/places.js";
import { home } from "../src/places/schema.js";
import { restoreMarkerFile } from "../src/system/restore.js";
import { updatePendingFile } from "../src/update-pending.js";
import {
  claimed,
  get,
  post,
  sharedClient,
  signIn,
  testCore,
  type TestCore,
} from "./support.js";

// Restores from a backup. The manager leaves a marker in the core's data
// volume; the core signs every device out before it serves anyone, keeps the
// date for Settings and deletes the marker. An update rollback leaves no marker
// and signs nobody out.

// A claimed host with a personal and a shared client, then the core started
// again on its data, with what the manager left there.
async function restart(leave: Record<string, string> = {}) {
  const before = await testCore();
  const admin = await claimed(before);
  const tablet = sharedClient(before);
  for (const [file, content] of Object.entries(leave)) {
    await writeFile(join(before.dataDir, file), content);
  }
  const after = await testCore({ dataDir: before.dataDir });
  return { before, after, admin, tablet };
}

const marker = JSON.stringify({ backupAt: "2026-10-18T09:12:00.000Z" });

function signedIn(core: TestCore, token: string) {
  return get(core, "/api/auth/me", { token }).then(
    (response) => response.statusCode === 200,
  );
}

describe("a restore from a backup", () => {
  it("signs every device out before the core serves anyone", async () => {
    const { after, admin, tablet } = await restart({
      [restoreMarkerFile]: marker,
    });

    expect(await signedIn(after, admin.token)).toBe(false);
    expect(await signedIn(after, tablet.token)).toBe(false);
    expect(existsSync(join(after.dataDir, restoreMarkerFile))).toBe(false);
    expect(after.logs).toContain(
      "Restored from a backup of 2026-10-18T09:12:00.000Z: 2 devices signed out",
    );
    expect(
      after.activity
        .recent()
        .filter((entry) => entry.source === "system")
        .map(({ action, outcome }) => ({ action, outcome })),
    ).toEqual([{ action: "restore", outcome: "ok" }]);
  });

  it("drops every pairing request, so shared devices show new codes", async () => {
    const before = await testCore();
    const admin = await claimed(before);
    const request = await post(before, "/api/auth/pair/request", {
      platform: "android",
      suggestedName: "Lenovo Tab",
    });
    expect(request.statusCode).toBe(200);
    const asked = request.json();
    // Approved but not yet collected, the case that would hand out a token.
    const approved = await post(
      before,
      "/api/auth/pair/approve",
      { code: asked.code, name: "Kitchen tablet" },
      { token: admin.token },
    );
    expect(approved.statusCode).toBe(204);
    await writeFile(join(before.dataDir, restoreMarkerFile), marker);

    const after = await testCore({ dataDir: before.dataDir });

    const polled = await post(after, "/api/auth/pair/poll", {
      deviceSecret: asked.deviceSecret,
    });
    expect(polled.statusCode).toBe(409);
    expect(polled.json()).toEqual({ error: "expired" });
  });

  it("keeps people, logins and the claim, so the admin signs in again", async () => {
    const { after } = await restart({ [restoreMarkerFile]: marker });

    const again = await signIn(after);

    expect(again.outcome).toBe("signed-in");
    expect((await get(after, "/api/auth/status")).json()).toMatchObject({
      claimed: true,
    });
  });

  it("keeps the home's id, on the same host or another", async () => {
    const { before, after } = await restart({ [restoreMarkerFile]: marker });
    // New hardware: another host id and CA, the same data.
    const movedHostId = "2c1d9a8e-5b0f-4c47-9d1e-7a3b6f2e4d10";
    const moved = await testCore({
      dataDir: before.dataDir,
      hostId: movedHostId,
    });

    expect(after.homeId).toBe(before.homeId);
    expect((await get(moved, "/api/auth/status")).json()).toMatchObject({
      hostId: movedHostId,
      homeId: before.homeId,
    });
    // Signing in again binds the new host and the same home.
    const again = await signIn(moved, {
      sees: { hostId: movedHostId, homeId: before.homeId, pin: null },
    });
    expect(again.outcome).toBe("signed-in");
  });

  it("from before home ids gets a new one, so apps take it for another home", async () => {
    const { before, admin } = await restart();
    const named = await post(
      before,
      "/api/places/home/update",
      { name: "Maya's home" },
      { token: admin.token },
    );
    expect(named.statusCode).toBe(200);
    // What the migration leaves of a backup made before home ids.
    before.db.update(home).set({ homeId: null }).where(eq(home.id, 1)).run();

    const after = await testCore({ dataDir: before.dataDir });

    expect(after.homeId).not.toBe(before.homeId);
    expect(loadHomeId(after.db)).toBe(after.homeId);
    expect(after.places.list().home.name).toBe("Maya's home");
  });

  it("tells admins in Settings, until one dismisses it", async () => {
    const { after } = await restart({ [restoreMarkerFile]: marker });
    const again = await signIn(after);
    if (again.outcome !== "signed-in") throw new Error("not signed in");
    const admin = { token: again.body.token };

    const shown = await get(after, "/api/system/restore", admin);
    const dismissed = await post(
      after,
      "/api/system/restore/dismiss",
      {},
      admin,
    );
    const gone = await get(after, "/api/system/restore", admin);

    expect(shown.json()).toEqual({
      restore: {
        restoredAt: "2026-10-26T12:00:00.000Z",
        backupAt: "2026-10-18T09:12:00.000Z",
      },
    });
    expect(dismissed.statusCode).toBe(204);
    expect(gone.json()).toEqual({ restore: null });
  });

  it("shows to a shared client too", async () => {
    const { after } = await restart({ [restoreMarkerFile]: marker });
    const tablet = sharedClient(after);

    const response = await get(after, "/api/system/restore", tablet);

    expect(response.json()).toEqual({
      restore: expect.objectContaining({ restoredAt: expect.any(String) }),
    });
  });

  it("signs devices out even when the marker cannot be read", async () => {
    const { after, admin } = await restart({ [restoreMarkerFile]: "{" });
    const again = await signIn(after);
    if (again.outcome !== "signed-in") throw new Error("not signed in");

    expect(await signedIn(after, admin.token)).toBe(false);
    expect(
      (
        await get(after, "/api/system/restore", { token: again.body.token })
      ).json(),
    ).toEqual({
      restore: { restoredAt: "2026-10-26T12:00:00.000Z", backupAt: null },
    });
  });
});

describe("an update rollback", () => {
  it("signs nobody out", async () => {
    // The manager put the snapshot back and started the previous core; the
    // update's own marker may still be there for a moment.
    const { after, admin, tablet } = await restart({
      [updatePendingFile]: "a1b2c3d4",
    });

    expect(await signedIn(after, admin.token)).toBe(true);
    expect(await signedIn(after, tablet.token)).toBe(true);
    expect((await get(after, "/api/system/restore", admin)).json()).toEqual({
      restore: null,
    });
  });
});

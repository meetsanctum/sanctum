import { openAppStorage } from "@meetsanctum/app-sdk/storage";
import Database from "better-sqlite3";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

// What an update's commit rests on: what an app has committed is on the disk,
// in its file, before its runner says so.

const migrationsFolder = fileURLToPath(
  new URL("./fixtures/apps/notes/migrations", import.meta.url),
);

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) {
    await rm(folder, { recursive: true, force: true });
  }
});

async function opened() {
  const folder = await mkdtemp(join(tmpdir(), "sanctum-sync-"));
  folders.push(folder);
  const file = join(folder, "app.db");
  return {
    file,
    storage: openAppStorage(file, { appId: "test.notes", migrationsFolder }),
  };
}

const insert = (text: string) => ({
  sql: "INSERT INTO notes (text) VALUES (?)",
  params: [text],
  method: "run" as const,
});

describe("syncing an app's database", () => {
  it("moves what it committed out of the log and into the file", async () => {
    const { file, storage } = await opened();
    await storage.call().query(insert("kept"));
    expect(statSync(`${file}-wal`).size).toBeGreaterThan(0);

    await storage.sync();

    expect(statSync(`${file}-wal`).size).toBe(0);
    storage.close();
    expect(existsSync(`${file}-wal`)).toBe(false);
    const read = new Database(file, { readonly: true });
    expect(read.prepare("SELECT text FROM notes").all()).toEqual([
      { text: "kept" },
    ]);
    read.close();
  });

  it("waits for a call part way through a transaction, and syncs what it committed", async () => {
    const { file, storage } = await opened();
    const call = storage.call();
    await call.query({ sql: "BEGIN", params: [], method: "run" });
    await call.query(insert("late"));
    let synced = false;

    const syncing = storage.sync().then(() => {
      synced = true;
    });
    await new Promise((done) => setTimeout(done, 20));
    expect(synced).toBe(false);

    await call.query({ sql: "COMMIT", params: [], method: "run" });
    await syncing;

    expect(statSync(`${file}-wal`).size).toBe(0);
    storage.close();
  });

  it("carries on once a call that left its transaction open has ended", async () => {
    const { storage } = await opened();
    const call = storage.call();
    await call.query({ sql: "BEGIN", params: [], method: "run" });
    await call.query(insert("rolled back"));

    const syncing = storage.sync();
    call.end();
    await syncing;

    expect(
      await storage
        .call()
        .query({ sql: "SELECT text FROM notes", params: [], method: "all" }),
    ).toEqual({ rows: [] });
    storage.close();
  });

  it("refuses once the database has closed", async () => {
    const { storage } = await opened();
    storage.close();

    await expect(storage.sync()).rejects.toThrow("has closed");
  });
});

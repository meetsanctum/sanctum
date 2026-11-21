import { NewerDatabaseError } from "@meetsanctum/app-sdk/storage";
import {
  appendFile,
  cp,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { createClients } from "../src/auth/clients.js";
import { hashToken } from "../src/auth/tokens.js";
import { migrationsFolder, openCoreDatabase } from "../src/database.js";
import { people } from "../src/people/schema.js";

async function tempDir() {
  const folder = await mkdtemp(join(tmpdir(), "sanctum-core-"));
  onTestFinished(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

// A copy of this build's migrations plus one more, as a newer build has.
async function extraMigrations(isEarlier = false) {
  const folder = join(await tempDir(), "migrations");
  await cp(migrationsFolder, folder, { recursive: true });
  const journalPath = join(folder, "meta", "_journal.json");
  const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
    entries: { idx: number; when: number; tag: string }[];
  };
  const last = journal.entries.at(-1)!;
  const extra = {
    ...last,
    idx: isEarlier ? 0 : last.idx + 1,
    when: isEarlier ? journal.entries[0]!.when - 1 : last.when + 1,
    tag: "9999_newer",
  };
  if (isEarlier) {
    journal.entries = [extra, ...journal.entries].map((entry, idx) => ({
      ...entry,
      idx,
    }));
  } else {
    journal.entries.push(extra);
  }
  await writeFile(journalPath, JSON.stringify(journal));
  await writeFile(
    join(folder, "9999_newer.sql"),
    "CREATE TABLE `newer` (`id` text PRIMARY KEY NOT NULL);",
  );
  return folder;
}

describe("the core's database", () => {
  it("is created and migrated on first start, and kept on the next", async () => {
    const dataDir = await tempDir();
    const first = openCoreDatabase(dataDir);
    const now = new Date();
    first.db
      .insert(people)
      .values({
        id: "maya",
        name: "Maya",
        colour: "#c5cdac",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    first.close();

    const second = openCoreDatabase(dataDir);
    expect(second.db.select().from(people).all()).toMatchObject([
      { id: "maya", name: "Maya", avatar: null },
    ]);
    second.close();
  });

  it("keeps existing personal and shared clients signed in when adding agents", async () => {
    const dataDir = await tempDir();
    const previousMigrations = join(await tempDir(), "migrations");
    await cp(migrationsFolder, previousMigrations, { recursive: true });
    const journalPath = join(previousMigrations, "meta", "_journal.json");
    const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
      entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter((entry) => entry.idx < 45);
    await writeFile(journalPath, JSON.stringify(journal));

    const before = openCoreDatabase(dataDir, {
      migrationsFolder: previousMigrations,
    });
    // Seed the earlier schema through SQLite since it has no agent columns.
    before.db.$client.exec(`
      INSERT INTO people (id, name, colour, created_at, updated_at)
        VALUES ('maya', 'Maya', '#c5cdac', 0, 0);
      INSERT INTO auth_clients (id, name, kind, person_id, platform, created_at)
        VALUES ('laptop', 'Laptop', 'personal', 'maya', 'macos', 0),
               ('tablet', 'Tablet', 'shared', NULL, 'ios', 0);
    `);
    const tokens = ["client_laptop", "client_tablet"];
    const insertToken = before.db.$client.prepare(
      "INSERT INTO auth_tokens (id, client_id, kind, token_hash, created_at) VALUES (?, ?, 'client', ?, 0)",
    );
    insertToken.run("one", "laptop", hashToken(tokens[0]!));
    insertToken.run("two", "tablet", hashToken(tokens[1]!));
    before.close();

    const after = openCoreDatabase(dataDir);
    onTestFinished(after.close);
    const clients = createClients(after.db, {
      record: () => "unused",
      connections: { closeClient() {}, connectedSince: () => null },
      now: () => new Date(),
    });
    expect(
      tokens.map((token) => clients.authenticate(token)?.client.kind),
    ).toEqual(["personal", "shared"]);
    expect(after.db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("refuses a database a newer build has migrated", async () => {
    const dataDir = await tempDir();
    openCoreDatabase(dataDir, {
      migrationsFolder: await extraMigrations(),
    }).close();

    expect(() => openCoreDatabase(dataDir)).toThrow(NewerDatabaseError);
  });

  it("applies a newer migration after the known history", async () => {
    const dataDir = await tempDir();
    openCoreDatabase(dataDir).close();
    const folder = await extraMigrations();

    openCoreDatabase(dataDir, { migrationsFolder: folder }).close();
    openCoreDatabase(dataDir, { migrationsFolder: folder }).close();
    expect(() => openCoreDatabase(dataDir)).toThrow(NewerDatabaseError);
  });

  it("rolls back a migration that leaves a broken foreign key", async () => {
    const dataDir = await tempDir();
    openCoreDatabase(dataDir).close();
    const folder = await extraMigrations();
    await appendFile(
      join(folder, "9999_newer.sql"),
      `\n--> statement-breakpoint\nINSERT INTO auth_tokens
        (id, client_id, kind, token_hash, created_at)
        VALUES ('orphan', 'missing', 'client', 'unused', 0);`,
    );

    expect(() =>
      openCoreDatabase(dataDir, { migrationsFolder: folder }),
    ).toThrow("Core migration broke a foreign key in auth_tokens");
    const previous = openCoreDatabase(dataDir);
    onTestFinished(previous.close);
    expect(previous.db.$client.pragma("foreign_key_check")).toEqual([]);
  });

  it("refuses different migration contents with the same timestamp", async () => {
    const dataDir = await tempDir();
    const folder = join(await tempDir(), "migrations");
    await cp(migrationsFolder, folder, { recursive: true });
    await appendFile(
      join(folder, "0000_people.sql"),
      "\n--> statement-breakpoint\nCREATE TABLE different (id text);",
    );
    openCoreDatabase(dataDir, { migrationsFolder: folder }).close();

    expect(() => openCoreDatabase(dataDir)).toThrow(NewerDatabaseError);
  });

  it("refuses an unapplied migration inserted before the applied history", async () => {
    const dataDir = await tempDir();
    openCoreDatabase(dataDir).close();
    const folder = await extraMigrations(true);

    expect(() =>
      openCoreDatabase(dataDir, { migrationsFolder: folder }),
    ).toThrow(NewerDatabaseError);
  });
});

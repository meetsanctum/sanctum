import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";

import { NewerDatabaseError, openAppStorage } from "../src/storage.js";

// An app's migrations: a parent table and a child whose rows go with their
// parent, then the parent rebuilt the way drizzle-kit writes a change SQLite
// can't make in place.
const created = `CREATE TABLE \`rooms\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`name\` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE \`lamps\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`room_id\` text NOT NULL,
  FOREIGN KEY (\`room_id\`) REFERENCES \`rooms\`(\`id\`) ON UPDATE no action ON DELETE cascade
);`;

const rebuilt = `PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE \`__new_rooms\` (
  \`id\` text PRIMARY KEY NOT NULL,
  \`name\` text NOT NULL,
  \`floor\` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
INSERT INTO \`__new_rooms\`("id", "name") SELECT "id", "name" FROM \`rooms\`;--> statement-breakpoint
DROP TABLE \`rooms\`;--> statement-breakpoint
ALTER TABLE \`__new_rooms\` RENAME TO \`rooms\`;--> statement-breakpoint
PRAGMA foreign_keys=ON;`;

async function tempDir() {
  const folder = await mkdtemp(join(tmpdir(), "sanctum-app-storage-"));
  onTestFinished(() => rm(folder, { recursive: true, force: true }));
  return folder;
}

// A migrations folder as drizzle-kit writes one, holding `migrations` in order.
async function migrationsFolder(migrations: string[]) {
  const folder = join(await tempDir(), "migrations");
  await mkdir(join(folder, "meta"), { recursive: true });
  const entries = migrations.map((_, idx) => ({
    idx,
    version: "6",
    when: 1_790_000_000_000 + idx,
    tag: `000${idx}_step`,
    breakpoints: true,
  }));
  await writeFile(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ version: "7", dialect: "sqlite", entries }),
  );
  for (const [idx, sql] of migrations.entries()) {
    await writeFile(join(folder, `000${idx}_step.sql`), sql);
  }
  return folder;
}

async function databaseFile() {
  return join(await tempDir(), "app.db");
}

function open(file: string, folder: string) {
  return openAppStorage(file, {
    appId: "sanctum.example",
    migrationsFolder: folder,
  });
}

function seed(file: string) {
  const sqlite = new Database(file);
  sqlite.exec(`
    INSERT INTO rooms (id, name) VALUES ('office', 'Office');
    INSERT INTO lamps (id, room_id) VALUES ('desk', 'office'), ('shelf', 'office');
  `);
  sqlite.close();
}

function read(file: string, sql: string) {
  const sqlite = new Database(file, { readonly: true });
  try {
    return sqlite.prepare(sql).all();
  } finally {
    sqlite.close();
  }
}

describe("an app's migrations", () => {
  it("keep a child's rows when they rebuild its parent table", async () => {
    const file = await databaseFile();
    open(file, await migrationsFolder([created])).close();
    seed(file);

    open(file, await migrationsFolder([created, rebuilt])).close();

    expect(read(file, "SELECT id, name, floor FROM rooms")).toEqual([
      { id: "office", name: "Office", floor: 0 },
    ]);
    expect(read(file, "SELECT id, room_id FROM lamps ORDER BY id")).toEqual([
      { id: "desk", room_id: "office" },
      { id: "shelf", room_id: "office" },
    ]);
  });

  it("turn foreign keys back on once they have run", async () => {
    const file = await databaseFile();
    const storage = open(file, await migrationsFolder([created, rebuilt]));
    onTestFinished(storage.close);

    await expect(
      storage.call().query({
        sql: "INSERT INTO lamps (id, room_id) VALUES ('lost', 'nowhere')",
        params: [],
        method: "run",
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("carry on from a database Drizzle's migrator began", async () => {
    const file = await databaseFile();
    const sqlite = new Database(file);
    migrate(drizzle({ client: sqlite }), {
      migrationsFolder: await migrationsFolder([created]),
    });
    sqlite.close();
    seed(file);

    const folder = await migrationsFolder([created, rebuilt]);
    open(file, folder).close();
    open(file, folder).close();

    expect(read(file, "SELECT count(*) AS count FROM lamps")).toEqual([
      { count: 2 },
    ]);
    expect(
      read(file, "SELECT count(*) AS count FROM __drizzle_migrations"),
    ).toEqual([{ count: 2 }]);
  });

  it("roll back a migration that leaves a broken foreign key", async () => {
    const file = await databaseFile();
    open(file, await migrationsFolder([created])).close();
    seed(file);
    const orphan = `DROP TABLE \`rooms\`;--> statement-breakpoint
CREATE TABLE \`rooms\` (\`id\` text PRIMARY KEY NOT NULL, \`name\` text NOT NULL);`;

    const folder = await migrationsFolder([created, orphan]);
    expect(() => open(file, folder)).toThrow(
      "A migration of sanctum.example's database broke a foreign key in lamps",
    );
    expect(read(file, "SELECT id FROM rooms")).toEqual([{ id: "office" }]);
    expect(
      read(file, "SELECT count(*) AS count FROM __drizzle_migrations"),
    ).toEqual([{ count: 1 }]);
  });

  it("refuse a database a newer build has migrated", async () => {
    const file = await databaseFile();
    open(file, await migrationsFolder([created, rebuilt])).close();

    const folder = await migrationsFolder([created]);
    expect(() => open(file, folder)).toThrow(NewerDatabaseError);
  });
});

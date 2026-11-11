import { NewerDatabaseError } from "@meetsanctum/app-sdk/storage";
import { appendFile, cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { migrationsFolder, openCoreDatabase } from "../src/database.js";
import { people } from "../src/people/schema.js";

const tempDir = () => mkdtemp(join(tmpdir(), "sanctum-core-"));

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

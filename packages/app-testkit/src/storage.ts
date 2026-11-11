import type { StorageQuery, StorageResult } from "@meetsanctum/app-sdk";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

// An app's own database for its tests: a SQLite file in memory with the
// app's migrations applied, answering the app's statements as the core's
// storage does, rows as arrays of values.
// It does not check what a statement does, as the core does.

export function createTestStorage(options: { migrationsFolder: string }) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  migrate(drizzle({ client: sqlite }), {
    migrationsFolder: options.migrationsFolder,
  });

  return {
    /** CoreCalls' `query`, for createAppContext. */
    async query({ sql, params, method }: StorageQuery): Promise<StorageResult> {
      const statement = sqlite.prepare(sql);
      if (method === "run" || !statement.reader) {
        statement.run(params);
        return { rows: [] };
      }
      statement.raw(true);
      return method === "get"
        ? { rows: statement.get(params) as unknown[] | undefined }
        : { rows: statement.all(params) };
    },
    close() {
      sqlite.close();
    },
  };
}

export type TestStorage = ReturnType<typeof createTestStorage>;

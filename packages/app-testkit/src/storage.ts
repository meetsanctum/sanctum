import type { StorageQuery, StorageResult } from "@meetsanctum/app-sdk";
import { migrateDatabase } from "@meetsanctum/app-sdk/storage";
import Database from "better-sqlite3";

// An app's own database for its tests: a SQLite file in memory with the
// app's migrations applied as its runner applies them, answering the app's
// statements as the core's storage does, rows as arrays of values.
// It does not check what a statement does, as the core does.

export function createTestStorage(options: { migrationsFolder: string }) {
  const sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  migrateDatabase(sqlite, options.migrationsFolder, "The app's database");

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

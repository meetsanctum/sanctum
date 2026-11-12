import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import type { StorageQuery, StorageResult } from "./context.js";

// Each app's own SQLite file, opened and migrated by its runner in its
// container.
// App code reaches it only through `query`, Drizzle's sqlite-proxy calls.
// Isolation is by file: the connection opens nothing else, so an app sees
// neither the core's database nor another app's tables.

export class NewerDatabaseError extends Error {}

// A database carrying migrations this build does not have was written by a
// newer build, such as after pushing an older one to a dev host: this code
// would not know its tables. An update that brings one up fails its health
// check and rolls back.
export function assertKnownMigrations(
  sqlite: Database.Database,
  folder: string,
  name = "The core's database",
) {
  const known = readMigrationFiles({ migrationsFolder: folder });
  const table = sqlite
    .prepare(
      "select 1 from sqlite_master where type = 'table' and name = '__drizzle_migrations'",
    )
    .get();
  if (!table) {
    return;
  }
  const applied = sqlite
    .prepare(
      "select hash, created_at as createdAt from __drizzle_migrations order by created_at",
    )
    .all() as { hash: string; createdAt: number | string }[];
  // The applied history must be an exact prefix of this build's migrations.
  // Timestamps alone miss changed SQL, and membership alone misses gaps that
  // Drizzle skips because it only applies migrations after the latest timestamp.
  const isKnownHistory = applied.every((row, index) => {
    const migration = known[index];
    return (
      migration?.folderMillis === Number(row.createdAt) &&
      migration.hash === row.hash
    );
  });
  if (!isKnownHistory) {
    throw new NewerDatabaseError(
      `${name} migration history does not match this build; it was written by a newer or different build`,
    );
  }
}

// What an app's statements may do: read and change its own rows, in
// transactions if it likes. Its schema changes only through its migrations,
// and nothing may name another file (ATTACH, VACUUM INTO) or change the
// connection (PRAGMA).
const allowedStatements = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "REPLACE",
  "WITH",
  "VALUES",
  "BEGIN",
  "COMMIT",
  "END",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
]);

// A statement's first keyword, after any comments. SQLite decides what a
// statement does from it, and better-sqlite3 prepares exactly one statement.
function firstKeyword(sql: string) {
  const rest = sql.replace(/^(?:\s+|--[^\n]*|\/\*[\s\S]*?\*\/)*/, "");
  return /^[A-Za-z]+/.exec(rest)?.[0].toUpperCase();
}

// A statement an app may not run.
class StorageRefusal extends Error {}

export type AppStorage = ReturnType<typeof openAppStorage>;

// Opens the app's file, creating it on first use, and applies the app's
// migrations from its package.
export function openAppStorage(
  file: string,
  options: { appId: string; migrationsFolder?: string },
) {
  mkdirSync(dirname(file), { recursive: true });
  const sqlite = new Database(file);
  try {
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("foreign_keys = ON");
    if (options.migrationsFolder) {
      assertKnownMigrations(
        sqlite,
        options.migrationsFolder,
        `${options.appId}'s database`,
      );
      migrate(drizzle({ client: sqlite }), {
        migrationsFolder: options.migrationsFolder,
      });
    }
  } catch (error) {
    sqlite.close();
    throw error;
  }

  // A transaction belongs to the call that began it. Drizzle runs one as
  // separate statements across an async boundary, so another call's
  // statements wait until it ends rather than running inside it.
  type Call = { ended: boolean };
  let owner: Call | undefined;
  let closed = false;
  const waiting: (() => void)[] = [];

  function release() {
    owner = undefined;
    for (const wake of waiting.splice(0)) {
      wake();
    }
  }

  function run({ sql, params, method }: StorageQuery): StorageResult {
    const keyword = firstKeyword(sql);
    if (!keyword || !allowedStatements.has(keyword)) {
      throw new StorageRefusal(
        `${options.appId} may not run ${keyword ?? "this"} statements on its database`,
      );
    }
    const statement = sqlite.prepare(sql);
    if (method === "run" || !statement.reader) {
      statement.run(params);
      return { rows: [] };
    }
    statement.raw(true);
    return method === "get"
      ? { rows: statement.get(params) as unknown[] | undefined }
      : { rows: statement.all(params) };
  }

  return {
    // The storage side of one action call. `end` rolls back a transaction
    // the call left open, such as when it timed out.
    call() {
      const call: Call = { ended: false };
      return {
        async query(query: StorageQuery): Promise<StorageResult> {
          while (owner && owner !== call && !closed && !call.ended) {
            await new Promise<void>((resolve) => waiting.push(resolve));
          }
          if (closed || call.ended) {
            throw new Error(`This call to ${options.appId} has ended`);
          }
          try {
            return run(query);
          } finally {
            if (sqlite.inTransaction) {
              owner = call;
            } else if (owner === call) {
              release();
            }
          }
        },
        // Whether the call is over, so nothing it does changes anything.
        get ended() {
          return call.ended || closed;
        },
        end() {
          call.ended = true;
          if (owner === call) {
            if (sqlite.inTransaction) {
              sqlite.exec("ROLLBACK");
            }
            release();
          }
        },
      };
    },

    // What it has committed so far is on the disk, in the file itself. SQLite as
    // it's set up here can lose its last commits in a power cut until then. A call
    // that's part way through a transaction finishes first.
    async sync() {
      while (owner && !closed) {
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      if (closed) throw new Error(`${options.appId}'s database has closed`);
      const [result] = sqlite.pragma("wal_checkpoint(TRUNCATE)") as {
        busy: number;
      }[];
      if (result?.busy) {
        throw new Error(`${options.appId}'s database is busy`);
      }
    },

    close() {
      closed = true;
      release();
      sqlite.close();
    },
  };
}

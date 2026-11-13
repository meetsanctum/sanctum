import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

import type { ChangedBy, RecordActivity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import { systemRestores } from "./schema.js";

// Restores from a backup. The manager holds no auth logic: when it puts back
// an older backup, or one onto new hardware, it leaves this marker in the
// core's data volume, with when the backup was taken. On its next start,
// before it serves anyone, the core signs every device out in one
// transaction, keeps the date for the message in Settings → System, and
// deletes the marker. An update rollback leaves no marker, so it signs
// nobody out.
//
//   restored    {"backupAt": "2026-10-18T09:12:00.000Z"}
export const restoreMarkerFile = "restored";

const marker = z.object({ backupAt: z.iso.datetime({ offset: true }) });

export type RestoreInfo = {
  restoredAt: string;
  // What people and passwords are as of; null when not known.
  backupAt: string | null;
};

// The marker, or none. One the core cannot read still means a restore: a
// device signed out for nothing is better than one left signed in.
function readMarker(path: string): { backupAt: Date | null } | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  try {
    return { backupAt: new Date(marker.parse(JSON.parse(text)).backupAt) };
  } catch {
    return { backupAt: null };
  }
}

export function createRestores(
  db: CoreDatabase,
  options: {
    dataDir: string;
    // Revokes every client and its tokens; called inside the transaction.
    signOutEveryone: (at: Date) => number;
    record: RecordActivity;
    log: (message: string) => void;
    now: () => Date;
  },
) {
  const { record, now } = options;

  function latest() {
    return db
      .select()
      .from(systemRestores)
      .orderBy(desc(systemRestores.restoredAt))
      .limit(1)
      .get();
  }

  return {
    // Handles the manager's marker, if there is one. Runs once, as the core
    // starts. A crash before the marker is gone handles it again, which
    // changes nothing more: nobody could sign in meanwhile.
    applyMarker() {
      const path = join(options.dataDir, restoreMarkerFile);
      const found = readMarker(path);
      if (!found) {
        return false;
      }
      const at = now();
      const signedOut = db.transaction(() => {
        const count = options.signOutEveryone(at);
        db.insert(systemRestores)
          .values({
            id: randomUUID(),
            restoredAt: at,
            backupAt: found.backupAt,
          })
          .run();
        record({ action: "restore", outcome: "ok" });
        return count;
      });
      rmSync(path, { force: true });
      options.log(
        `Restored from a backup${found.backupAt ? ` of ${found.backupAt.toISOString()}` : ""}: ${signedOut} devices signed out`,
      );
      return true;
    },

    // The last restore, until someone dismisses its message.
    current(): RestoreInfo | null {
      const restore = latest();
      if (!restore || restore.dismissedAt) {
        return null;
      }
      return {
        restoredAt: restore.restoredAt.toISOString(),
        backupAt: restore.backupAt?.toISOString() ?? null,
      };
    },

    dismiss(by: ChangedBy) {
      db.transaction(() => {
        const restore = latest();
        if (!restore || restore.dismissedAt) {
          return;
        }
        db.update(systemRestores)
          .set({ dismissedAt: now(), dismissedBy: by.personId ?? null })
          .where(eq(systemRestores.id, restore.id))
          .run();
        record({
          action: "restore.dismiss",
          outcome: "ok",
          ...by,
          subjectId: restore.id,
        });
      });
    },
  };
}

export type Restores = ReturnType<typeof createRestores>;

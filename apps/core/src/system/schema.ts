import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// System's tables: restores of the core's data from a backup, kept for the
// message admins see in Settings → System. An update rollback is not one of
// them.

export const systemRestores = sqliteTable("system_restores", {
  id: text("id").primaryKey(),
  // When the core found the manager's marker and signed every device out.
  restoredAt: integer("restored_at", { mode: "timestamp_ms" }).notNull(),
  // When the backup was taken, which the data is as of; null when the
  // marker did not say.
  backupAt: integer("backup_at", { mode: "timestamp_ms" }),
  // The admin who read the message and dismissed it.
  dismissedAt: integer("dismissed_at", { mode: "timestamp_ms" }),
  dismissedBy: text("dismissed_by"),
});

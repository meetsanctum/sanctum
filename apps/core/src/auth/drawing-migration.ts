import type Database from "better-sqlite3";

// The journal timestamps for dropping the three-way choices and adding the
// switches. Carry explicit On choices across both steps in the transaction.
const dropChoices = 1795710670873;
const addSwitches = 1795710671490;

export function migrateDrawingChoices(sqlite: Database.Database) {
  let enabled: { id: string; effects: number; motion: number }[] = [];
  return {
    before(time: number) {
      if (time !== dropChoices) return;
      enabled = sqlite
        .prepare<[], (typeof enabled)[number]>(
          `SELECT id, reduce_effects = 'on' AS effects,
                     reduce_motion = 'on' AS motion
             FROM auth_clients
            WHERE reduce_effects = 'on' OR reduce_motion = 'on'`,
        )
        .all();
    },
    after(time: number) {
      if (time !== addSwitches || enabled.length === 0) return;
      const update = sqlite.prepare(
        "UPDATE auth_clients SET reduced_effects = ?, reduced_motion = ? WHERE id = ?",
      );
      for (const { id, effects, motion } of enabled) {
        update.run(effects, motion, id);
      }
    },
  };
}

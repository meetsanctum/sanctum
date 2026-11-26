import type { RecordActivity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import { createPower, type PowerAction, type PowerManager } from "./power.js";
import { createRestores } from "./restore.js";
import { createSpace, type SpaceManager } from "./space.js";
import { createStatus, type StatusManager } from "./status.js";
import { createUpdates, type UpdateManager } from "./updates.js";

export type SystemManager = PowerManager &
  SpaceManager &
  StatusManager &
  UpdateManager;

export function assembleSystem(
  db: CoreDatabase,
  options: {
    manager: SystemManager;
    dataDir: string;
    version: string;
    record: RecordActivity;
    signOutEveryone: (at: Date) => number;
    appIds: () => readonly string[];
    announce: (going: PowerAction) => void;
    log: (message: string) => void;
    now?: () => Date;
  },
) {
  const { manager, dataDir, version, record, log, now } = options;
  const restores = createRestores(db, {
    dataDir,
    signOutEveryone: options.signOutEveryone,
    record,
    log,
    now: now ?? (() => new Date()),
  });
  // A restore from a backup signs every device out before the core serves
  // anyone.
  restores.applyMarker();
  return {
    restores,
    updates: createUpdates({ manager, version, record }),
    status: createStatus({
      manager,
      dataDir,
      version,
      appIds: options.appIds,
      now,
    }),
    power: createPower({ manager, record, announce: options.announce }),
    space: createSpace({ manager, record }),
    record,
  };
}

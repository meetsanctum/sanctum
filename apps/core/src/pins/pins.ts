import { asc } from "drizzle-orm";
import { z } from "zod";

import type { Rule } from "../app-host/gate.js";
import type { CoreDatabase } from "../database.js";
import { pinnedApps } from "./schema.js";

// The Pins module: the household's pinned apps, which the sidebar shows at
// its top in their order. Like the dashboards they belong to the household,
// not to a person or a client, so every client reads and changes them,
// shared ones included. Pinning arranges the sidebar; it is not something
// that happened in the home, so the activity log records nothing.
//
// The core does not check the ids against the installed apps, and nothing
// unpins an app that goes: clients show only the pins they can open, and a
// reinstalled app comes back where it was pinned.

// Reading them is a read, and changing them a write.
export const pinRules = {
  read: { tier: "read" },
  change: { tier: "write" },
} as const satisfies Record<string, Rule>;

// Far more than a sidebar shows; it keeps any one client from filling the
// database.
export const maxPins = 100;

const id = z.string().min(1).max(64);

export const pinsUpdate = z.object({
  apps: z
    .array(id)
    .max(maxPins)
    .refine((ids) => new Set(ids).size === ids.length, "Each app once"),
});

export function createPins(
  db: CoreDatabase,
  options: {
    // Called after a change has committed, so live clients can follow.
    onChange?: (apps: string[]) => void;
  } = {},
) {
  function list(): string[] {
    return db
      .select({ id: pinnedApps.appId })
      .from(pinnedApps)
      .orderBy(asc(pinnedApps.position), asc(pinnedApps.appId))
      .all()
      .map((row) => row.id);
  }

  return {
    list,

    // The whole list in its new order, so pinning, unpinning and reordering
    // are each one update.
    update(input: z.input<typeof pinsUpdate>): string[] {
      const { apps } = pinsUpdate.parse(input);
      const stored = db.transaction(() => {
        db.delete(pinnedApps).run();
        if (apps.length > 0) {
          db.insert(pinnedApps)
            .values(apps.map((appId, position) => ({ appId, position })))
            .run();
        }
        return list();
      });
      options.onChange?.(stored);
      return stored;
    },
  };
}

export type Pins = ReturnType<typeof createPins>;

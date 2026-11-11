import {
  grantedAtFirst,
  permissionIds,
  type PermissionRequest,
} from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";

import type { CoreDatabase } from "../database.js";
import type { Rule } from "./gate.js";
import { appGrants } from "./schema.js";

// Apps' grants: whether the household lets an app have each permission it
// asks for. What an app may do is what it asks for and was granted; a
// permission it no longer asks for counts for nothing, though its row stays
// for when it asks again.
//
// When the core first sees an app ask for a permission, it grants one the
// app needs and an optional one its out-of-the-box behaviour needs
// (startsOn), and leaves every other optional one off until the app's page
// asks for it where it is used. A permission keeps the answer it has, so a
// home keeps what its apps held before.

// Granting an app a permission, or taking it away.
export const permissionsRule: Rule = { tier: "write" };

// What an app asks for, as its manifest says.
type AppAsking = {
  id: string;
  permissions: readonly (Pick<PermissionRequest, "needed" | "startsOn"> & {
    id: string;
  })[];
};

export function createAppGrants(
  db: CoreDatabase,
  options: { now?: () => Date } = {},
) {
  const now = options.now ?? (() => new Date());

  function rows(appId: string) {
    return new Map(
      db
        .select()
        .from(appGrants)
        .where(eq(appGrants.appId, appId))
        .all()
        .map((row) => [row.permission, row.granted]),
    );
  }

  return {
    // Answers each permission the app asks for that has no answer yet.
    adopt(app: AppAsking): void {
      const known = rows(app.id);
      const unanswered = app.permissions.filter(
        (request) => !known.has(request.id),
      );
      if (unanswered.length === 0) return;
      const updatedAt = now();
      db.insert(appGrants)
        .values(
          unanswered.map((request) => ({
            appId: app.id,
            permission: request.id,
            granted: grantedAtFirst(request),
            updatedAt,
          })),
        )
        .onConflictDoNothing()
        .run();
    },

    // What the app may do now: the permissions it asks for that are
    // granted, in the order it asks for them.
    of(app: AppAsking): string[] {
      const known = rows(app.id);
      return permissionIds(app.permissions).filter(
        (permission) => known.get(permission) === true,
      );
    },

    // Grants or takes away one permission the app asks for, writing the
    // activity entry in the same transaction. False, and nothing changed,
    // when the app does not ask for it or it already has that answer.
    set(
      app: AppAsking,
      permission: string,
      granted: boolean,
      record: () => void,
    ): boolean {
      if (!permissionIds(app.permissions).includes(permission)) return false;
      if (rows(app.id).get(permission) === granted) return false;
      db.transaction(() => {
        const set = { granted, updatedAt: now() };
        db.insert(appGrants)
          .values({ appId: app.id, permission, ...set })
          .onConflictDoUpdate({
            target: [appGrants.appId, appGrants.permission],
            set,
          })
          .run();
        record();
      });
      return true;
    },
  };
}

export type AppGrants = ReturnType<typeof createAppGrants>;

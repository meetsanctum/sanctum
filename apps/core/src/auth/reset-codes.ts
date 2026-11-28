import { and, eq, gt, isNull } from "drizzle-orm";

import type { CoreDatabase } from "../database.js";
import { authInvites } from "./schema.js";

// An outstanding reset code cannot replace a password someone sets for themselves.
export function endResetCodes(db: CoreDatabase, personId: string, at: Date) {
  db.update(authInvites)
    .set({ endedReason: "cancelled", endedAt: at })
    .where(
      and(
        eq(authInvites.personId, personId),
        eq(authInvites.kind, "reset"),
        isNull(authInvites.endedReason),
        gt(authInvites.expiresAt, at),
      ),
    )
    .run();
}

import { pageTicketPrefix } from "@meetsanctum/auth-protocol";
import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";

import { authClients, authTokens } from "../auth/schema.js";
import { hashToken } from "../auth/tokens.js";
import type { CoreDatabase } from "../database.js";

// Page tickets: what a client's frames carry in their address to load apps'
// page files and the kit, since a frame's own loads can't carry the client's
// token. Each signed-in client asks for one, shared ones too. A ticket opens
// page files and nothing else, so one that leaks is no worse than none. Each
// lasts a week and a day: the client asks for the next within the week, and
// a page that's open keeps loading through the day after. Like other tokens
// only their hashes are kept, beside their client, which revoking ends them
// with.

/** A client asks for the next ticket within this. */
export const ticketWeekMs = 7 * 24 * 60 * 60_000;
/** And each still opens files this long after that. */
export const ticketGraceMs = 24 * 60 * 60_000;
// A client that asks often, as one that restarts does, holds this many at most.
const keptPerClient = 4;

const ticketPattern = new RegExp(`^${pageTicketPrefix}[A-Za-z0-9_-]{43}$`);

/** Whether a string can be a ticket at all, before anything is looked up. */
export const looksLikeTicket = (value: string) => ticketPattern.test(value);

export function createPageTickets(
  db: CoreDatabase,
  options: { now: () => Date },
) {
  const { now } = options;
  const lifetimeMs = ticketWeekMs + ticketGraceMs;

  const holderOf = db
    .select({ clientId: authTokens.clientId })
    .from(authTokens)
    .innerJoin(authClients, eq(authTokens.clientId, authClients.id))
    .where(
      and(
        eq(authTokens.tokenHash, sql.placeholder("tokenHash")),
        eq(authTokens.kind, "page"),
        gt(authTokens.createdAt, sql.placeholder("since")),
        isNull(authTokens.revokedAt),
        isNull(authClients.revokedAt),
      ),
    )
    .prepare();

  return {
    /** A new ticket for a signed-in client, and when it stops opening files. */
    issue(clientId: string): { ticket: string; expiresAt: Date } {
      const at = now();
      const ticket = `${pageTicketPrefix}${randomBytes(32).toString("base64url")}`;
      db.transaction((tx) => {
        // Its tickets that have run out, and all but its newest few.
        tx.delete(authTokens)
          .where(
            and(
              eq(authTokens.clientId, clientId),
              eq(authTokens.kind, "page"),
              lte(authTokens.createdAt, new Date(at.getTime() - lifetimeMs)),
            ),
          )
          .run();
        const kept = tx
          .select({ id: authTokens.id })
          .from(authTokens)
          .where(
            and(eq(authTokens.clientId, clientId), eq(authTokens.kind, "page")),
          )
          .orderBy(asc(authTokens.createdAt))
          .all();
        for (const { id } of kept.slice(
          0,
          Math.max(0, kept.length - (keptPerClient - 1)),
        )) {
          tx.delete(authTokens).where(eq(authTokens.id, id)).run();
        }
        tx.insert(authTokens)
          .values({
            id: randomUUID(),
            clientId,
            kind: "page",
            tokenHash: hashToken(ticket),
            createdAt: at,
          })
          .run();
      });
      return { ticket, expiresAt: new Date(at.getTime() + lifetimeMs) };
    },

    /** The client a ticket is good for now, if it is good for any. */
    holder(ticket: string): string | null {
      if (!looksLikeTicket(ticket)) return null;
      const found = holderOf.get({
        tokenHash: hashToken(ticket),
        since: now().getTime() - lifetimeMs,
      });
      return found?.clientId ?? null;
    },
  };
}

export type PageTickets = ReturnType<typeof createPageTickets>;

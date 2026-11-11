import {
  newPairingCode,
  normalisePairingCode,
  pairingRequestMs,
  type PairApprove,
  type PairingRequestInfo,
  type PairLookup,
  type PairPoll,
  type PairPolled,
  type PairRequest,
  type PairRequested,
} from "@meetsanctum/auth-protocol";
import { and, eq, gt, isNull, lte } from "drizzle-orm";
import { randomBytes, randomUUID } from "node:crypto";

import type { RecordActivity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import { changedBy } from "./callers.js";
import { clientInfo, type Clients, type Principal } from "./clients.js";
import { AuthError } from "./errors.js";
import { addressKey, defaultLimits, type Limits } from "./limits.js";
import { authPairingRequests } from "./schema.js";
import { hashToken } from "./tokens.js";

// Pairing a shared device. The device asks for a request and gets a display
// code and a device secret, of which the host keeps only hashes. Someone
// looks the code up and approves it from another of the home's clients, a
// shared one too; the device then collects its token with the secret.
// Approving and collecting are separate steps, each in one transaction, so
// approving a code shown on another screen never hands a token to whoever
// started a different request.

type Request = typeof authPairingRequests.$inferSelect;

const requests = authPairingRequests;

// How the admin sees the address: IPv4 without its IPv6 mapping.
function shownAddress(address: string) {
  return address.replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "");
}

export function createPairing(
  db: CoreDatabase,
  options: {
    clients: Clients;
    record: RecordActivity;
    limits?: Limits;
    now: () => Date;
  },
) {
  const { clients, record, now } = options;
  const limits = options.limits ?? defaultLimits;
  // Where a cap was reached and logged, until when: a device that keeps
  // asking leaves one entry, not one every few seconds.
  const reported = new Map<string, number>();

  // Requests are kept until they expire, used up or not.
  function sweep() {
    db.delete(requests).where(lte(requests.expiresAt, now())).run();
  }

  // Refuses a request over a cap, and logs the first refusal.
  function refuse(key: string, address: string): never {
    const at = now().getTime();
    for (const [reportedKey, until] of reported) {
      if (until <= at) {
        reported.delete(reportedKey);
      }
    }
    if (!reported.has(key)) {
      reported.set(key, at + pairingRequestMs);
      record({
        action: "pair.request",
        outcome: "refused",
        reason: "busy",
        address,
      });
    }
    throw new AuthError("busy");
  }

  // A request still waiting for an admin: not expired, approved or used.
  function waiting(code: string) {
    const normalised = normalisePairingCode(code);
    if (!normalised) {
      throw new AuthError("invalid_request");
    }
    const request = db
      .select()
      .from(requests)
      .where(
        and(
          eq(requests.codeHash, hashToken(normalised)),
          gt(requests.expiresAt, now()),
          isNull(requests.approvedAt),
          isNull(requests.clientId),
        ),
      )
      .get();
    if (!request) {
      throw new AuthError("not_found");
    }
    return { request, code: normalised };
  }

  function info(request: Request, code: string): PairingRequestInfo {
    return {
      code,
      platform: request.platform,
      suggestedName: request.suggestedName,
      address: shownAddress(request.sourceAddress),
      createdAt: request.createdAt.toISOString(),
      expiresAt: request.expiresAt.toISOString(),
    };
  }

  return {
    // Step 1, before a principal exists. Open requests are capped per
    // address and across the host.
    request(address: string, input: PairRequest): PairRequested {
      const key = addressKey(address);
      const made = db.transaction(
        (): { over: string } | { requested: PairRequested } => {
          sweep();
          const open = db
            .select({ sourceAddress: requests.sourceAddress })
            .from(requests)
            .where(isNull(requests.clientId))
            .all();
          if (open.length >= limits.pairingTotal) {
            return { over: "host" };
          }
          if (
            open.filter((request) => addressKey(request.sourceAddress) === key)
              .length >= limits.pairingPerAddress
          ) {
            return { over: key };
          }
          // The display code identifies the request by itself, so it is
          // unique among the requests kept.
          let code: string;
          do {
            code = newPairingCode();
          } while (
            db
              .select({ id: requests.id })
              .from(requests)
              .where(eq(requests.codeHash, hashToken(code)))
              .get()
          );
          const deviceSecret = randomBytes(32).toString("base64url");
          const createdAt = now();
          const expiresAt = new Date(createdAt.getTime() + pairingRequestMs);
          db.insert(requests)
            .values({
              id: randomUUID(),
              codeHash: hashToken(code),
              deviceSecretHash: hashToken(deviceSecret),
              platform: input.platform,
              suggestedName: input.suggestedName,
              sourceAddress: address,
              createdAt,
              expiresAt,
            })
            .run();
          return {
            requested: {
              code,
              deviceSecret,
              expiresAt: expiresAt.toISOString(),
            },
          };
        },
      );
      // Refused outside the transaction, which would take the log entry
      // back with it.
      if ("over" in made) {
        refuse(made.over, address);
      }
      return made.requested;
    },

    // Step 3: any client, a shared one too, sees what asked. Never the
    // device secret.
    lookup(input: PairLookup): PairingRequestInfo {
      const { request, code } = waiting(input.code);
      return info(request, code);
    },

    // Step 3: records who approved it, the person if there is one, and the
    // name they gave the device. A code can be approved once.
    approve(principal: Principal, input: PairApprove) {
      const by = changedBy(principal);
      db.transaction(() => {
        const { request } = waiting(input.code);
        db.update(requests)
          .set({
            approvedBy: by.personId ?? null,
            approvedAt: now(),
            name: input.name,
          })
          .where(eq(requests.id, request.id))
          .run();
        record({
          action: "pair.approve",
          outcome: "ok",
          ...by,
          subjectId: request.id,
        });
      });
    },

    // Drops every request, approved or not, after a restore from a backup:
    // each shared device shows a new code.
    dropAll() {
      db.delete(requests).run();
    },

    // Step 4: the device holding the secret collects its token once the
    // request is approved. Collecting checks that the request has not
    // expired, then creates the shared client and uses the request up, in
    // one transaction.
    poll(address: string, input: PairPoll): PairPolled {
      const polled = db.transaction((): PairPolled | "expired" => {
        const request = db
          .select()
          .from(requests)
          .where(eq(requests.deviceSecretHash, hashToken(input.deviceSecret)))
          .get();
        if (
          !request ||
          request.expiresAt.getTime() <= now().getTime() ||
          request.clientId
        ) {
          return "expired";
        }
        if (!request.approvedAt || !request.name) {
          return { status: "waiting" };
        }
        const { client, token } = clients.createShared({
          name: request.name,
          platform: request.platform,
          approvedBy: request.approvedBy ?? undefined,
        });
        db.update(requests)
          .set({ clientId: client.id })
          .where(eq(requests.id, request.id))
          .run();
        record({
          action: "client.pair",
          outcome: "ok",
          personId: request.approvedBy ?? undefined,
          clientId: client.id,
          subjectId: request.id,
          address,
        });
        return {
          status: "paired",
          token,
          client: clientInfo(client, client.id),
        };
      });
      // The device starts a new request.
      if (polled === "expired") {
        throw new AuthError("expired");
      }
      return polled;
    },
  };
}

export type Pairing = ReturnType<typeof createPairing>;

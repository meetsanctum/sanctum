import {
  normalisePairingCode,
  pairingAnswerMs,
  pairingCodeAlphabet,
  pairingConfirmation,
  pairingExchangesPerRequest,
  pairingOpaque,
  pairingProtocol,
  pairingRequestMs,
  splitPairingCode,
  verifyPairingBinding,
  type HostView,
  type PairAnswer,
  type PairAnswered,
  type PairApprove,
  type PairBind,
  type PairExchange,
  type PairExchangeFailure,
  type PairExchangeStarted,
  type PairExchangeStatus,
  type PairLookup,
  type PairPoll,
  type PairPolled,
  type PairRequest,
  type PairRequested,
} from "@meetsanctum/auth-protocol";
import * as opaque from "@serenity-kit/opaque";
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import {
  createHmac,
  randomBytes,
  randomInt,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import type { RecordActivity } from "../activity/activity.js";
import type { CoreDatabase } from "../database.js";
import { changedBy } from "./callers.js";
import { clientInfo, type Clients, type Principal } from "./clients.js";
import { AuthError } from "./errors.js";
import {
  addressKey,
  defaultLimits,
  type Limiter,
  type Limits,
} from "./limits.js";
import { authPairingRequests } from "./schema.js";
import { hashToken } from "./tokens.js";

// Pairing a shared device. The device asks for a request and gets the first
// characters of its display code and a device secret, of which the host keeps
// only the hash; the device draws the rest of the code itself and never sends
// it. Whoever approves types the whole code on another of the home's clients,
// a shared one too. The host then runs OPAQUE with the device through the
// device's own calls, the host knowing the code and the device holding a
// one-time record of it: only a device that shows this code finishes, and
// only on a connection to this host, which the device's binding shows. Then
// whoever typed the code approves it, and the device collects its token with
// the secret and checks the host's confirmation before it trusts the host.
//
// An exchange's state, the code among it, lives in memory: a restart drops
// exchanges under way, and an approved device that hasn't collected yet asks
// again with a new code.

type Request = typeof authPairingRequests.$inferSelect;

type Exchange = {
  id: string;
  requestId: string;
  // The client that typed the code, the only one that sees and approves it.
  approverId: string;
  stage: "started" | "answered" | "verified" | "failed";
  startLoginRequest: string;
  // Until the device answers: the typed secret and OPAQUE's client state.
  secret?: string;
  clientLoginState?: string;
  // Once it answered.
  finishLoginRequest?: string;
  sessionKey?: string;
  secretDigest?: Buffer;
  reason?: PairExchangeFailure;
  // The device answers by then, and binds by then once it answered.
  until: number;
};

const requests = authPairingRequests;
const lookupCharacters = [...pairingCodeAlphabet];
const lookups = lookupCharacters.flatMap((first) =>
  lookupCharacters.map((second) => first + second),
);

// A lookup rests this long after its request expired or was used up.
const restMs = pairingRequestMs;

export function createPairing(
  db: CoreDatabase,
  options: {
    clients: Clients;
    record: RecordActivity;
    // The host as a paired device must see it.
    host: () => HostView;
    limiter: Limiter;
    limits?: Limits;
    now: () => Date;
  },
) {
  const { clients, limiter, record, now } = options;
  const limits = options.limits ?? defaultLimits;
  // Where a cap was reached and logged, until when: a device that keeps
  // asking leaves one entry, not one every few seconds.
  const reported = new Map<string, number>();
  // Every request's latest exchange, by request id.
  const exchanges = new Map<string, Exchange>();
  // The short typed secret needs a keyed hash to compare it on resume.
  const secretDigestKey = randomBytes(32);

  function digestSecret(secret: string) {
    return createHmac("sha256", secretDigestKey).update(secret).digest();
  }

  // Requests are kept until their lookup has rested, used up or not.
  function sweep() {
    const before = new Date(now().getTime() - restMs);
    db.delete(requests).where(lte(requests.expiresAt, before)).run();
    for (const [requestId, exchange] of exchanges) {
      if (!byId(requestId)) {
        exchanges.delete(exchange.requestId);
      }
    }
  }

  function byId(id: string) {
    return db.select().from(requests).where(eq(requests.id, id)).get();
  }

  function isOpen(request: Request | undefined): request is Request {
    return (
      !!request &&
      request.expiresAt.getTime() > now().getTime() &&
      !request.clientId
    );
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

  // A request can't be approved or collected any more; its lookup rests.
  function cancel(requestId: string) {
    db.update(requests)
      .set({ expiresAt: now() })
      .where(eq(requests.id, requestId))
      .run();
  }

  // Ends an exchange that didn't check the device. A device that sees
  // another host, or doesn't finish an exchange it answered, is cancelled
  // and reported at once; otherwise the request ends, reported, once its
  // exchanges have run out, since an interceptor can make its work look like
  // a mistyped code.
  function fail(exchange: Exchange, reason: PairExchangeFailure) {
    exchange.stage = "failed";
    exchange.reason = reason;
    delete exchange.secret;
    delete exchange.clientLoginState;
    delete exchange.sessionKey;
    delete exchange.secretDigest;
    const request = byId(exchange.requestId);
    if (!isOpen(request)) {
      return;
    }
    const spent = request.exchanges >= pairingExchangesPerRequest;
    if (reason === "channel_mismatch" || reason === "unchecked" || spent) {
      cancel(request.id);
      record({
        action: "pair.check",
        outcome: "refused",
        reason:
          reason === "channel_mismatch" || reason === "unchecked"
            ? reason
            : "too_many_attempts",
        clientId: exchange.approverId,
        subjectId: request.id,
        address: request.sourceAddress,
      });
    }
  }

  // Ends an exchange whose time is up, when it is next read.
  function settle(exchange: Exchange) {
    if (exchange.until > now().getTime()) {
      return;
    }
    if (exchange.stage === "started") {
      fail(exchange, "no_answer");
    } else if (exchange.stage === "answered") {
      fail(exchange, "unchecked");
    }
  }

  // The open request a device's secret belongs to, and its exchange.
  function deviceRequest(deviceSecret: string) {
    const request = db
      .select()
      .from(requests)
      .where(eq(requests.deviceSecretHash, hashToken(deviceSecret)))
      .get();
    if (!isOpen(request)) {
      // The device starts a new request.
      throw new AuthError("expired");
    }
    const exchange = exchanges.get(request.id);
    if (exchange) {
      settle(exchange);
    }
    return { request, exchange };
  }

  // The exchange a device answers: its request's latest.
  function deviceExchange(deviceSecret: string, exchangeId: string) {
    const { exchange } = deviceRequest(deviceSecret);
    if (!exchange || exchange.id !== exchangeId) {
      throw new AuthError("expired");
    }
    return exchange;
  }

  // The exchange the client that typed the code follows.
  function approverExchange(principal: Principal, input: PairExchange) {
    const exchange = exchanges.get(input.requestId);
    if (
      !exchange ||
      exchange.id !== input.exchangeId ||
      exchange.approverId !== principal.client.id
    ) {
      throw new AuthError("not_found");
    }
    settle(exchange);
    return exchange;
  }

  return {
    // Step 1, before a principal exists. Open requests are capped per
    // address and across the host.
    request(address: string, input: PairRequest): PairRequested {
      if (input.protocol !== pairingProtocol) {
        throw new AuthError("pairing_outdated");
      }
      const key = addressKey(address);
      const made = db.transaction(
        (): { over: string } | { requested: PairRequested } => {
          sweep();
          const open = db
            .select({ sourceAddress: requests.sourceAddress })
            .from(requests)
            .where(
              and(isNull(requests.clientId), gt(requests.expiresAt, now())),
            )
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
          // The lookup finds the request by itself, so it is unique among
          // the requests kept, resting ones included.
          const reserved = new Set(
            db
              .select({ lookup: requests.lookup })
              .from(requests)
              .all()
              .map(({ lookup }) => lookup),
          );
          const free = lookups.filter((lookup) => !reserved.has(lookup));
          if (free.length === 0) {
            return { over: "host" };
          }
          const lookup = free[randomInt(free.length)]!;
          const deviceSecret = randomBytes(32).toString("base64url");
          const createdAt = now();
          const expiresAt = new Date(createdAt.getTime() + pairingRequestMs);
          const requestId = randomUUID();
          db.insert(requests)
            .values({
              id: requestId,
              lookup,
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
              requestId,
              lookup,
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

    // Step 2: any client, a shared one too, types the code. The host starts
    // an exchange with the device that shows it, counted before it starts,
    // and keeps the code only until the device answers.
    lookup(principal: Principal, input: PairLookup): PairExchangeStarted {
      const code = normalisePairingCode(input.code);
      if (!code) {
        throw new AuthError("invalid_request");
      }
      const { lookup, secret } = splitPairingCode(code);
      const found = () =>
        db.select().from(requests).where(eq(requests.lookup, lookup)).get();
      const current = exchanges.get(found()?.id ?? "");
      // An exchange whose time is up may end the request.
      if (current) {
        settle(current);
      }
      const request = found();
      if (!isOpen(request) || request.approvedAt) {
        throw new AuthError("not_found");
      }
      // Keep the active exchange through approval, including while the
      // approver names a verified device or returns and types its code again.
      if (current && current.stage !== "failed") {
        if (
          current.stage === "verified" &&
          current.approverId === principal.client.id &&
          current.secretDigest &&
          timingSafeEqual(current.secretDigest, digestSecret(secret))
        ) {
          return { requestId: request.id, exchangeId: current.id };
        }
        throw new AuthError("busy");
      }
      if (request.exchanges >= pairingExchangesPerRequest) {
        throw new AuthError("too_many_attempts");
      }
      limiter.work();
      db.update(requests)
        .set({ exchanges: sql`${requests.exchanges} + 1` })
        .where(eq(requests.id, request.id))
        .run();
      const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
        password: secret,
      });
      const exchange: Exchange = {
        id: randomUUID(),
        requestId: request.id,
        approverId: principal.client.id,
        stage: "started",
        startLoginRequest,
        secret,
        clientLoginState,
        until: now().getTime() + pairingAnswerMs,
      };
      exchanges.set(request.id, exchange);
      return { requestId: request.id, exchangeId: exchange.id };
    },

    // Step 2, for the client that typed the code: how the exchange went,
    // and what asked once the device is checked.
    exchange(principal: Principal, input: PairExchange): PairExchangeStatus {
      const exchange = approverExchange(principal, input);
      if (exchange.stage === "failed") {
        return { status: "failed", reason: exchange.reason! };
      }
      if (exchange.stage !== "verified") {
        return { status: "exchanging" };
      }
      const request = byId(exchange.requestId);
      if (!isOpen(request)) {
        throw new AuthError("not_found");
      }
      return {
        status: "verified",
        request: {
          platform: request.platform,
          suggestedName: request.suggestedName,
          createdAt: request.createdAt.toISOString(),
          expiresAt: request.expiresAt.toISOString(),
        },
      };
    },

    // Step 3: the client that typed the code approves the request its
    // exchange checked, with the name it gave the device, and only that
    // request. A request is approved once.
    approve(principal: Principal, input: PairApprove) {
      const by = changedBy(principal);
      db.transaction(() => {
        const exchange = approverExchange(principal, input);
        const request = byId(exchange.requestId);
        if (
          exchange.stage !== "verified" ||
          !isOpen(request) ||
          request.approvedAt
        ) {
          throw new AuthError("not_found");
        }
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
      exchanges.clear();
    },

    // The device's calls. It polls with its secret: for an exchange to
    // answer, and once approved, for its token. Collecting checks that the
    // request is open and approved and its exchange checked the device, then
    // creates the shared client and uses the request up, in one transaction.
    async poll(address: string, input: PairPoll): Promise<PairPolled> {
      const collected = db.transaction(() => {
        const { request, exchange } = deviceRequest(input.deviceSecret);
        if (!request.approvedAt || !request.name) {
          return { request, exchange, paired: undefined };
        }
        if (exchange?.stage !== "verified" || !exchange.sessionKey) {
          // Approved before a restart dropped its exchange.
          cancel(request.id);
          return "expired" as const;
        }
        const paired = clients.createShared({
          name: request.name,
          platform: request.platform,
          approvedBy: request.approvedBy ?? undefined,
        });
        db.update(requests)
          .set({ clientId: paired.client.id })
          .where(eq(requests.id, request.id))
          .run();
        record({
          action: "client.pair",
          outcome: "ok",
          personId: request.approvedBy ?? undefined,
          clientId: paired.client.id,
          subjectId: request.id,
          address,
        });
        return { request, exchange, paired };
      });
      if (collected === "expired") {
        // The device starts a new request.
        throw new AuthError("expired");
      }
      const { request, exchange, paired } = collected;
      if (paired) {
        exchanges.delete(request.id);
        return {
          status: "paired",
          token: paired.token,
          client: clientInfo(paired.client, paired.client.id),
          confirmation: await pairingConfirmation(
            exchange!.sessionKey!,
            options.host(),
            { requestId: request.id, exchangeId: exchange!.id },
            paired.token,
          ),
        };
      }
      if (exchange?.stage === "started") {
        return {
          status: "exchange",
          exchangeId: exchange.id,
          startLoginRequest: exchange.startLoginRequest,
        };
      }
      return { status: "waiting" };
    },

    // The device's answer to an exchange. Each exchange takes one answer;
    // the same answer again gets the same reply, without running OPAQUE
    // again.
    answer(input: PairAnswer): PairAnswered {
      const exchange = deviceExchange(input.deviceSecret, input.exchangeId);
      if (exchange.stage === "answered") {
        return {
          status: "continue",
          finishLoginRequest: exchange.finishLoginRequest!,
        };
      }
      if (exchange.stage !== "started") {
        return { status: "failed" };
      }
      limiter.work();
      const secret = exchange.secret!;
      let finished: opaque.client.FinishLoginResult | undefined;
      try {
        finished = opaque.client.finishLogin({
          clientLoginState: exchange.clientLoginState!,
          loginResponse: input.loginResponse,
          password: secret,
          identifiers: pairingOpaque.identifiers,
          keyStretching: pairingOpaque.keyStretching,
        });
      } catch {
        // A message that isn't OPAQUE's.
        finished = undefined;
      }
      delete exchange.secret;
      delete exchange.clientLoginState;
      if (!finished) {
        fail(exchange, "wrong_code");
        return { status: "failed" };
      }
      exchange.stage = "answered";
      exchange.sessionKey = finished.sessionKey;
      exchange.finishLoginRequest = finished.finishLoginRequest;
      exchange.secretDigest = digestSecret(secret);
      exchange.until = now().getTime() + pairingAnswerMs;
      return {
        status: "continue",
        finishLoginRequest: finished.finishLoginRequest,
      };
    },

    // The device's view of the host, bound to the exchange. Its MAC shows
    // the view is the device's own, so a view that differs from this host's
    // means something is in between.
    async bind(input: PairBind) {
      const exchange = deviceExchange(input.deviceSecret, input.exchangeId);
      if (exchange.stage === "verified") {
        return;
      }
      if (exchange.stage !== "answered" || !exchange.sessionKey) {
        throw new AuthError("expired");
      }
      const view: HostView = {
        hostId: input.hostId,
        homeId: input.homeId,
        pin: input.pin,
      };
      const ids = { requestId: exchange.requestId, exchangeId: exchange.id };
      const sessionKey = exchange.sessionKey;
      const bound = await verifyPairingBinding(
        sessionKey,
        view,
        ids,
        input.binding,
      );
      // The exchange may have expired or another bind may have verified it.
      const current = deviceExchange(input.deviceSecret, input.exchangeId);
      if (current.stage === "verified") {
        return;
      }
      if (current.stage !== "answered") {
        throw new AuthError("expired");
      }
      if (!bound) {
        fail(current, "unchecked");
        throw new AuthError("channel_mismatch");
      }
      const host = options.host();
      if (
        view.hostId !== host.hostId ||
        view.homeId !== host.homeId ||
        view.pin !== host.pin
      ) {
        fail(current, "channel_mismatch");
        throw new AuthError("channel_mismatch");
      }
      current.stage = "verified";
    },
  };
}

export type Pairing = ReturnType<typeof createPairing>;

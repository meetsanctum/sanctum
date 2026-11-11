import {
  keyStretching,
  platforms,
  type ClaimFinish,
  type ClaimStart,
  type Me,
  type PairApprove,
  type PairLookup,
  type PairPoll,
  type PairRequest,
  type PasswordFinish,
  type PasswordStart,
  type RemoveLogin,
  type RenameClient,
  type RevokeClient,
  type SetLoginFinish,
  type SetLoginStart,
  type SignInFinish,
  type SignInStart,
} from "@meetsanctum/auth-protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { newPerson } from "../people/people.js";
import type { People } from "../people/people.js";
import type { Auth } from "./auth.js";
import { parseRequest, personalCaller } from "./callers.js";
import type { Principal } from "./clients.js";
import { registerLive } from "./live.js";
import { personInfo } from "./logins.js";
import { bearerToken } from "./tokens.js";

// Auth's plain routes and the request check. Every route validates its input
// against a schema; each service call applies that route's exact permission
// rule and writes the activity log.

declare module "fastify" {
  interface FastifyContextConfig {
    // Runs before a principal exists, so needs no token.
    public?: boolean;
  }
  interface FastifyRequest {
    principal: Principal | null;
  }
}

// OPAQUE's messages and records are base64url.
const message = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(2_048);
const id = z.string().min(1).max(64);
const clientName = z.string().trim().min(1).max(60);
const newClient = z.object({ name: clientName, platform: z.enum(platforms) });
const username = z.string().max(64);
const stretching = z.number().int().min(1).max(keyStretching.version);

const schemas = {
  claimStart: z.object({
    username,
    registrationRequest: message,
  }) satisfies z.ZodType<ClaimStart>,
  claimFinish: z.object({
    registrationId: id,
    registrationRecord: message,
    keyStretching: stretching,
    person: newPerson,
    client: newClient,
  }) satisfies z.ZodType<ClaimFinish, unknown>,
  signInStart: z.object({
    username,
    startLoginRequest: message,
  }) satisfies z.ZodType<SignInStart>,
  signInFinish: z.object({
    signInId: id,
    finishLoginRequest: message,
    binding: message,
    client: newClient,
  }) satisfies z.ZodType<SignInFinish>,
  rename: z.object({ id, name: clientName }) satisfies z.ZodType<RenameClient>,
  revoke: z.object({ id }) satisfies z.ZodType<RevokeClient>,
  setLoginStart: z.object({
    personId: id,
    username,
    registrationRequest: message,
  }) satisfies z.ZodType<SetLoginStart>,
  setLoginFinish: z.object({
    registrationId: id,
    registrationRecord: message,
    keyStretching: stretching,
  }) satisfies z.ZodType<SetLoginFinish>,
  removeLogin: z.object({ personId: id }) satisfies z.ZodType<RemoveLogin>,
  passwordStart: z.object({
    startLoginRequest: message,
    registrationRequest: message,
  }) satisfies z.ZodType<PasswordStart>,
  pairRequest: z.object({
    platform: z.enum(platforms),
    suggestedName: clientName,
  }) satisfies z.ZodType<PairRequest>,
  pairLookup: z.object({
    code: z.string().max(32),
  }) satisfies z.ZodType<PairLookup>,
  pairApprove: z.object({
    code: z.string().max(32),
    name: clientName,
  }) satisfies z.ZodType<PairApprove>,
  pairPoll: z.object({
    deviceSecret: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(128),
  }) satisfies z.ZodType<PairPoll>,
  passwordFinish: z.object({
    changeId: id,
    finishLoginRequest: message,
    binding: message,
    registrationRecord: message,
    keyStretching: stretching,
  }) satisfies z.ZodType<PasswordFinish>,
};

const parse = parseRequest;

// The connection's own address; forwarded-for headers are not trusted.
function address(request: FastifyRequest) {
  return request.socket.remoteAddress ?? "unknown";
}

function principal(request: FastifyRequest) {
  return request.principal!;
}

export async function registerAuth(
  app: FastifyInstance,
  options: { auth: Auth; people: People },
) {
  const { auth, people } = options;
  const { clients, logins, pairing } = auth;

  app.decorateRequest("principal", null);

  // Every route needs a client token unless it is marked public: health,
  // the routes before a principal exists and the WebSocket, which
  // authenticates with its first message. CORS preflights never reach here.
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS" || request.routeOptions.config?.public) {
      return;
    }
    const token = bearerToken(request.headers.authorization);
    const found = token ? auth.authenticate(token) : undefined;
    if (!found) {
      return reply.code(401).send({ error: "invalid_client_token" });
    }
    request.principal = found;
  });

  const open = { config: { public: true } };

  app.get("/api/auth/status", open, async () => logins.status());

  app.post("/api/auth/claim/start", open, async (request) =>
    logins.claimStart(
      address(request),
      parse(schemas.claimStart, request.body),
    ),
  );
  app.post("/api/auth/claim/finish", open, async (request) =>
    logins.claimFinish(
      address(request),
      parse(schemas.claimFinish, request.body),
    ),
  );

  app.post("/api/auth/sign-in/start", open, async (request) =>
    logins.signInStart(
      address(request),
      parse(schemas.signInStart, request.body),
    ),
  );
  app.post("/api/auth/sign-in/finish", open, async (request) =>
    logins.signInFinish(
      address(request),
      parse(schemas.signInFinish, request.body),
    ),
  );

  // Pairing a shared device: the device asks and polls before a principal
  // exists; another authenticated client looks its code up and approves it.
  app.post("/api/auth/pair/request", open, async (request) =>
    pairing.request(address(request), parse(schemas.pairRequest, request.body)),
  );
  app.post("/api/auth/pair/poll", open, async (request) =>
    pairing.poll(address(request), parse(schemas.pairPoll, request.body)),
  );
  app.post("/api/auth/pair/lookup", async (request) =>
    pairing.lookup(parse(schemas.pairLookup, request.body)),
  );
  app.post("/api/auth/pair/approve", async (request, reply) => {
    pairing.approve(
      principal(request),
      parse(schemas.pairApprove, request.body),
    );
    return reply.code(204).send();
  });

  app.get("/api/auth/me", async (request): Promise<Me> => {
    const caller = principal(request);
    const person = caller.person && people.get(caller.person.id);
    return {
      client: clients.info(caller),
      person: person ? personInfo(person) : null,
    };
  });

  // Changing a password needs its person, so a personal client; the rest
  // every client may call, shared ones too.
  function personal(request: FastifyRequest) {
    const caller = principal(request);
    personalCaller(caller);
    return caller;
  }

  app.get("/api/auth/clients", async (request) =>
    clients.list(principal(request)),
  );
  app.post("/api/auth/clients/rename", async (request) =>
    clients.rename(principal(request), parse(schemas.rename, request.body)),
  );
  app.post("/api/auth/clients/revoke", async (request, reply) => {
    clients.revoke(principal(request), parse(schemas.revoke, request.body));
    return reply.code(204).send();
  });

  app.post("/api/auth/logins/set/start", async (request) =>
    logins.setLoginStart(
      principal(request),
      address(request),
      parse(schemas.setLoginStart, request.body),
    ),
  );
  app.post("/api/auth/logins/set/finish", async (request, reply) => {
    logins.setLoginFinish(
      principal(request),
      address(request),
      parse(schemas.setLoginFinish, request.body),
    );
    return reply.code(204).send();
  });
  app.post("/api/auth/logins/remove", async (request, reply) => {
    logins.removeLogin(
      principal(request),
      parse(schemas.removeLogin, request.body),
    );
    return reply.code(204).send();
  });

  app.post("/api/auth/password/start", async (request) =>
    logins.passwordStart(
      personal(request),
      address(request),
      parse(schemas.passwordStart, request.body),
    ),
  );
  app.post("/api/auth/password/finish", async (request, reply) => {
    await logins.passwordFinish(
      personal(request),
      address(request),
      parse(schemas.passwordFinish, request.body),
    );
    return reply.code(204).send();
  });

  await registerLive(app, {
    authenticate: auth.authenticate,
    connections: auth.connections,
  });
}

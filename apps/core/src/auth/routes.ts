import {
  keyStretching,
  platforms,
  type AgentInfo,
  type AgentSetupStarted,
  type AgentSetupStatus,
  type AgentTokenCollected,
  type CancelAgentSetup,
  type CancelInvite,
  type ClaimFinish,
  type ClaimStart,
  type CollectAgentToken,
  type InviteInfo,
  type InviteStart,
  type LoginInfo,
  type Me,
  type PairAnswer,
  type PairApprove,
  type PairBind,
  type PairExchange,
  type PairLookup,
  type PairPoll,
  type PairRequest,
  type PasswordChooseStart,
  type PasswordFinish,
  type PasswordStart,
  type RedeemCheck,
  type RedeemFinish,
  type RedeemRegister,
  type RedeemStart,
  type RegistrationFinish,
  type RemoveLogin,
  type RenameClient,
  type RevokeClient,
  type SetClientDrawing,
  type SetLoginStart,
  type SignInFinish,
  type SignInStart,
  type StartAgentSetup,
} from "@meetsanctum/auth-protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";

import { newPerson } from "../people/people.js";
import type { People } from "../people/people.js";
import type { Auth } from "./auth.js";
import { parseRequest, personalCaller } from "./callers.js";
import type { Principal } from "./clients.js";
import { AuthError } from "./errors.js";
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
    // The MCP endpoint, the one route an agent's token opens.
    agent?: boolean;
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
const deviceSecret = z
  .string()
  .regex(/^[A-Za-z0-9_-]+$/)
  .max(128);
const stretching = z.number().int().min(1).max(keyStretching.version);
const registrationFinish = z.object({
  registrationId: id,
  registrationRecord: message,
  keyStretching: stretching,
}) satisfies z.ZodType<RegistrationFinish>;

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
  drawing: z.object({
    id,
    reduceEffects: z.boolean().optional(),
    reduceMotion: z.boolean().optional(),
  }) satisfies z.ZodType<SetClientDrawing>,
  setLoginStart: z.object({
    personId: id,
    username,
    registrationRequest: message,
  }) satisfies z.ZodType<SetLoginStart>,
  removeLogin: z.object({ personId: id }) satisfies z.ZodType<RemoveLogin>,
  inviteStart: z.object({
    personId: id,
    kind: z.enum(["invite", "reset"]),
    replacesInviteId: id.optional(),
    registrationRequest: message,
  }) satisfies z.ZodType<InviteStart>,
  cancelInvite: z.object({
    personId: id,
    inviteId: id,
  }) satisfies z.ZodType<CancelInvite>,
  redeemStart: z.object({
    lookup: z.string().max(8),
    startLoginRequest: message,
  }) satisfies z.ZodType<RedeemStart>,
  redeemCheck: z.object({
    redeemId: id,
    finishLoginRequest: message,
    binding: message,
  }) satisfies z.ZodType<RedeemCheck>,
  redeemRegister: z.object({
    redeemId: id,
    username,
    registrationRequest: message,
  }) satisfies z.ZodType<RedeemRegister>,
  redeemFinish: z.object({
    redeemId: id,
    registrationRecord: message,
    keyStretching: stretching,
    binding: message,
    client: newClient,
  }) satisfies z.ZodType<RedeemFinish>,
  passwordStart: z.object({
    startLoginRequest: message,
    registrationRequest: message,
  }) satisfies z.ZodType<PasswordStart>,
  pairRequest: z.object({
    platform: z.enum(platforms),
    suggestedName: clientName,
    // Older clients sent no version.
    protocol: z.number().int().default(1),
  }) satisfies z.ZodType<PairRequest>,
  pairLookup: z.object({
    code: z.string().max(32),
  }) satisfies z.ZodType<PairLookup>,
  pairExchange: z.object({
    requestId: id,
    exchangeId: id,
  }) satisfies z.ZodType<PairExchange>,
  pairApprove: z.object({
    requestId: id,
    exchangeId: id,
    name: clientName,
  }) satisfies z.ZodType<PairApprove>,
  pairPoll: z.object({ deviceSecret }) satisfies z.ZodType<PairPoll>,
  pairAnswer: z.object({
    deviceSecret,
    exchangeId: id,
    loginResponse: message,
  }) satisfies z.ZodType<PairAnswer>,
  pairBind: z.object({
    deviceSecret,
    exchangeId: id,
    hostId: id,
    homeId: id,
    // A pin is base64url, none over plain HTTP.
    pin: message.nullable(),
    binding: message,
  }) satisfies z.ZodType<PairBind>,
  agentSetup: z.object({
    name: clientName,
  }) satisfies z.ZodType<StartAgentSetup>,
  cancelAgentSetup: z.object({
    setupId: id,
  }) satisfies z.ZodType<CancelAgentSetup>,
  collectAgent: z.object({
    setupId: id,
    secret: z
      .string()
      .regex(/^[A-Za-z0-9_-]+$/)
      .max(128),
    platform: z.enum(platforms),
    protocol: z.number().int().min(0),
  }) satisfies z.ZodType<CollectAgentToken>,
  passwordFinish: z.object({
    changeId: id,
    finishLoginRequest: message,
    binding: message,
    registrationRecord: message,
    keyStretching: stretching,
  }) satisfies z.ZodType<PasswordFinish>,
  passwordChooseStart: z.object({
    registrationRequest: message,
  }) satisfies z.ZodType<PasswordChooseStart>,
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
  const { clients, logins, pairing, agentSetups } = auth;

  app.decorateRequest("principal", null);

  // Every route needs a client token unless it is marked public: health,
  // the routes before a principal exists and the WebSocket, which
  // authenticates with its first message. CORS preflights never reach here.
  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS" || request.routeOptions.config?.public) {
      return;
    }
    const token = bearerToken(request.headers.authorization);
    // An agent's token opens the route marked as the MCP endpoint and
    // nothing else, so it can't act as a person's or a shared device's,
    // here or in the live connection (live.ts).
    const isAgentEndpoint = request.routeOptions.config?.agent === true;
    const found = token
      ? auth.authenticate(token, { recordAgentSeen: isAgentEndpoint })
      : undefined;
    if (!found) {
      return reply.code(401).send({ error: "invalid_client_token" });
    }
    if (found.scope === "agent" && !isAgentEndpoint) {
      return reply.code(403).send({ error: "forbidden" });
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

  // Pairing a shared device: the device asks, polls and answers its
  // exchanges before a principal exists; another authenticated client types
  // its code, follows the exchange and approves it.
  app.post("/api/auth/pair/request", open, async (request) =>
    pairing.request(address(request), parse(schemas.pairRequest, request.body)),
  );
  app.post("/api/auth/pair/poll", open, async (request) =>
    pairing.poll(address(request), parse(schemas.pairPoll, request.body)),
  );
  app.post("/api/auth/pair/answer", open, async (request) =>
    pairing.answer(parse(schemas.pairAnswer, request.body)),
  );
  app.post("/api/auth/pair/bind", open, async (request, reply) => {
    await pairing.bind(parse(schemas.pairBind, request.body));
    return reply.code(204).send();
  });
  app.post("/api/auth/pair/lookup", async (request) =>
    pairing.lookup(principal(request), parse(schemas.pairLookup, request.body)),
  );
  app.post("/api/auth/pair/exchange", async (request) =>
    pairing.exchange(
      principal(request),
      parse(schemas.pairExchange, request.body),
    ),
  );
  app.post("/api/auth/pair/approve", async (request, reply) => {
    pairing.approve(
      principal(request),
      parse(schemas.pairApprove, request.body),
    );
    return reply.code(204).send();
  });

  // Adding an AI agent: someone starts a setup on one of the home's clients
  // and watches it; the agent's connector collects its token with the code's
  // secret before a principal exists.
  app.get("/api/auth/agents", async (): Promise<AgentInfo[]> => auth.agents());
  app.post(
    "/api/auth/agents/setup",
    async (request): Promise<AgentSetupStarted> =>
      agentSetups.start(
        principal(request),
        parse(schemas.agentSetup, request.body),
        // The address this client reached the core at, which the connector
        // tries when discovery doesn't find the home. Only a hint: the
        // connector checks the home's pin before it sends anything.
        `${request.protocol}://${request.host}`,
      ),
  );
  app.get<{ Params: { id: string } }>(
    "/api/auth/agents/setup/:id",
    async (request): Promise<AgentSetupStatus> =>
      agentSetups.status(request.params.id),
  );
  app.post("/api/auth/agents/setup/cancel", async (request, reply) => {
    agentSetups.cancel(
      principal(request),
      parse(schemas.cancelAgentSetup, request.body).setupId,
    );
    return reply.code(204).send();
  });
  app.post(
    "/api/auth/agents/collect",
    open,
    async (request): Promise<AgentTokenCollected> =>
      agentSetups.collect(
        address(request),
        parse(schemas.collectAgent, request.body),
      ),
  );

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
  app.post("/api/auth/clients/drawing", async (request) =>
    clients.setDrawing(
      principal(request),
      parse(schemas.drawing, request.body),
    ),
  );
  app.post("/api/auth/clients/revoke", async (request, reply) => {
    clients.revoke(principal(request), parse(schemas.revoke, request.body));
    return reply.code(204).send();
  });

  app.get("/api/auth/logins", async (request): Promise<LoginInfo[]> => {
    principal(request);
    return logins.list();
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
      parse(registrationFinish, request.body),
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

  // Invites: any client makes, lists and cancels them; redeeming one needs
  // no token, as signing in doesn't.
  const invites = auth.invites;
  app.get("/api/auth/invites", async (request): Promise<InviteInfo[]> => {
    principal(request);
    return invites.list();
  });
  app.post("/api/auth/invites/start", async (request) =>
    invites.start(
      principal(request),
      address(request),
      parse(schemas.inviteStart, request.body),
    ),
  );
  app.post("/api/auth/invites/finish", async (request): Promise<InviteInfo> =>
    invites.finish(
      principal(request),
      address(request),
      parse(registrationFinish, request.body),
    ),
  );
  app.post("/api/auth/invites/cancel", async (request, reply) => {
    invites.cancel(
      principal(request),
      parse(schemas.cancelInvite, request.body),
    );
    return reply.code(204).send();
  });
  app.post("/api/auth/invites/redeem/start", open, async (request) =>
    invites.redeemStart(
      address(request),
      parse(schemas.redeemStart, request.body),
    ),
  );
  app.post("/api/auth/invites/redeem/check", open, async (request) =>
    invites.redeemCheck(
      address(request),
      parse(schemas.redeemCheck, request.body),
    ),
  );
  app.post("/api/auth/invites/redeem/register", open, async (request) =>
    invites.redeemRegister(
      address(request),
      parse(schemas.redeemRegister, request.body),
    ),
  );
  app.post("/api/auth/invites/redeem/finish", open, async (request) =>
    invites.redeemFinish(
      address(request),
      parse(schemas.redeemFinish, request.body),
    ),
  );

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
  app.post("/api/auth/password/choose/start", async (request) =>
    logins.passwordChooseStart(
      personal(request),
      address(request),
      parse(schemas.passwordChooseStart, request.body),
    ),
  );
  app.post("/api/auth/password/choose/finish", async (request, reply) => {
    personal(request);
    const input = parse(registrationFinish, request.body);
    // The device can be signed out while the request body is being read.
    const token = bearerToken(request.headers.authorization);
    const caller = token && auth.authenticate(token);
    if (!caller) throw new AuthError("invalid_client_token");
    logins.passwordChooseFinish(caller, address(request), input);
    return reply.code(204).send();
  });

  await registerLive(app, {
    authenticate: auth.authenticate,
    connections: auth.connections,
  });
}

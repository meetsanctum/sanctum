import {
  newPairingSecret,
  pairingBinding,
  pairingOpaque,
  pairingProtocol,
  verifyPairingConfirmation,
  type HostView,
  type PairExchangeStarted,
  type PairRequested,
} from "@meetsanctum/auth-protocol";
import * as opaque from "@serenity-kit/opaque";
import { expect } from "vitest";

import { hostId, post, type TestCore } from "./support.js";

// A shared device as the pairing tests drive it: it asks for a request,
// draws its half of the code and holds the one-time OPAQUE record, then
// answers the exchanges the host starts and checks the host's confirmation.

export const tablet = {
  platform: "android",
  suggestedName: "Lenovo Tab",
  protocol: pairingProtocol,
} as const;
export const tabletAddress = "192.168.7.50";

const { identifiers, userIdentifier, keyStretching } = pairingOpaque;

export type TestDevice = Awaited<ReturnType<typeof device>>;

export async function device(core: TestCore, remoteAddress = tabletAddress) {
  const response = await post(core, "/api/auth/pair/request", tablet, {
    remoteAddress,
  });
  expect(response.statusCode).toBe(200);
  const requested = response.json<PairRequested>();
  const secret = newPairingSecret();
  const serverSetup = opaque.server.createSetup();
  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password: secret });
  const { registrationResponse } = opaque.server.createRegistrationResponse({
    serverSetup,
    userIdentifier,
    registrationRequest,
  });
  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse,
    password: secret,
    identifiers,
    keyStretching,
  });
  const call = { remoteAddress };
  let sessionKey: string | undefined;
  let exchangeId: string | undefined;

  const poll = () =>
    post(
      core,
      "/api/auth/pair/poll",
      { deviceSecret: requested.deviceSecret },
      call,
    );

  return {
    ...requested,
    secret,
    code: `${requested.lookup}${secret}`,
    poll,

    // Answers the exchange the host started, OPAQUE's second message.
    async answer() {
      const polled = (await poll()).json();
      expect(polled.status).toBe("exchange");
      exchangeId = polled.exchangeId as string;
      const { serverLoginState, loginResponse } = opaque.server.startLogin({
        serverSetup,
        registrationRecord,
        startLoginRequest: polled.startLoginRequest,
        userIdentifier,
        identifiers,
      });
      const answered = await post(
        core,
        "/api/auth/pair/answer",
        { deviceSecret: requested.deviceSecret, exchangeId, loginResponse },
        call,
      );
      const body = answered.json();
      if (body.status === "continue") {
        sessionKey = opaque.server.finishLogin({
          serverLoginState,
          finishLoginRequest: body.finishLoginRequest,
          identifiers,
        }).sessionKey;
      }
      return { response: answered, body, loginResponse, exchangeId };
    },

    // Binds the finished exchange to the host the device sees.
    async bind(
      sees: HostView = { hostId, homeId: core.homeId, pin: null },
      binding?: string,
    ) {
      return post(
        core,
        "/api/auth/pair/bind",
        {
          deviceSecret: requested.deviceSecret,
          exchangeId,
          ...sees,
          binding:
            binding ??
            (await pairingBinding(sessionKey!, sees, {
              requestId: requested.requestId,
              exchangeId: exchangeId!,
            })),
        },
        call,
      );
    },

    // Checks the host's MAC over the token it collected.
    confirms(token: string, confirmation: string) {
      return verifyPairingConfirmation(
        sessionKey!,
        { hostId, homeId: core.homeId, pin: null },
        { requestId: requested.requestId, exchangeId: exchangeId! },
        token,
        confirmation,
      );
    },
  };
}

// Types a code on a client that is signed in.
export async function lookUp(core: TestCore, token: string, code: string) {
  return post(core, "/api/auth/pair/lookup", { code }, { token });
}

// How the exchange the approving client started is going.
export async function exchangeStatus(
  core: TestCore,
  token: string,
  started: PairExchangeStarted,
) {
  return (
    await post(core, "/api/auth/pair/exchange", started, { token })
  ).json();
}

export function approve(
  core: TestCore,
  token: string,
  started: PairExchangeStarted,
  name: string,
) {
  return post(core, "/api/auth/pair/approve", { ...started, name }, { token });
}

// Types the device's code and runs the exchange to the end.
export async function checked(
  core: TestCore,
  token: string,
  shown: TestDevice,
) {
  const lookedUp = await lookUp(core, token, shown.code);
  expect(lookedUp.statusCode).toBe(200);
  const started = lookedUp.json<PairExchangeStarted>();
  await shown.answer();
  expect((await shown.bind()).statusCode).toBe(204);
  return started;
}

// A device checked, approved and collected: its client and token.
export async function paired(
  core: TestCore,
  token: string,
  name = "Kitchen tablet",
) {
  const shown = await device(core);
  const started = await checked(core, token, shown);
  expect((await approve(core, token, started, name)).statusCode).toBe(204);
  const collected = (await shown.poll()).json();
  expect(collected.status).toBe("paired");
  return { shown, started, ...collected };
}

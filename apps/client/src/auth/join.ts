import {
  inviteCheckBinding,
  inviteCodeProof,
  inviteFinishBinding,
  keyStretching,
  normalisePassword,
  normaliseUsername,
  verifyInviteConfirmation,
  type HostView,
  type NewClient,
  type RedeemChecked,
  type RedeemFinish,
  type RedeemFinished,
  type RedeemRegistered,
  type RedeemStarted,
} from "@meetsanctum/auth-protocol";

import { coreJson } from "../core-fetch";
import { loadOpaque, SignInError } from "./device";

// Joining a home with an invite code, on the invited person's own device.
// The code is a one-time password: the device proves it through OPAQUE, so
// a wrong code fails here and nothing more is sent, and the proof is bound
// to the home the device checked, as signing in is. Then the person chooses
// a username and password, registered on this device, and the host signs
// it in. These are first-contact exchanges and carry no token.

export class JoinError extends Error {
  constructor(
    // The code doesn't open an invite, or rests after too many tries.
    readonly code:
      | "wrong_code"
      // The invite was made with a key stretching this app doesn't know.
      | "outdated",
  ) {
    super(code);
  }
}

/** A code that checked: whose invite it is, and what finishing needs. */
export type CheckedCode = {
  checked: RedeemChecked;
  sessionKey: string;
  host: HostView;
};

export async function checkInviteCode(input: {
  url: string;
  signal?: AbortSignal;
  host: HostView;
  code: string;
}): Promise<CheckedCode> {
  const proof = await inviteCodeProof(input.code);
  if (!proof) throw new JoinError("wrong_code");
  const { lookup, secret } = proof;
  const opaque = await loadOpaque();
  input.signal?.throwIfAborted();
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
    password: secret,
  });
  const started = await coreJson<RedeemStarted>(
    "/api/auth/invites/redeem/start",
    {
      at: input.url,
      signal: input.signal,
      method: "POST",
      json: { lookup, startLoginRequest },
      omitToken: true,
    },
  );
  if (started.keyStretching !== keyStretching.version) {
    throw new JoinError("outdated");
  }
  const login = opaque.client.finishLogin({
    clientLoginState,
    loginResponse: started.loginResponse,
    password: secret,
    keyStretching: keyStretching.profile,
  });
  if (!login) throw new JoinError("wrong_code");
  const checked = await coreJson<RedeemChecked>(
    "/api/auth/invites/redeem/check",
    {
      at: input.url,
      signal: input.signal,
      method: "POST",
      json: {
        redeemId: started.redeemId,
        finishLoginRequest: login.finishLoginRequest,
        binding: await inviteCheckBinding(login.sessionKey, input.host),
      },
      omitToken: true,
    },
  );
  return { checked, sessionKey: login.sessionKey, host: input.host };
}

// Registers the person's own username and password and signs this device
// in as them, once the host proves itself with the code's session.
export async function finishJoin(input: {
  url: string;
  signal?: AbortSignal;
  code: CheckedCode;
  username: string;
  password: string;
  client: NewClient;
}): Promise<RedeemFinished> {
  const { checked, sessionKey, host } = input.code;
  const opaque = await loadOpaque();
  input.signal?.throwIfAborted();
  const password = normalisePassword(input.password);
  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password });
  const registered = await coreJson<RedeemRegistered>(
    "/api/auth/invites/redeem/register",
    {
      at: input.url,
      signal: input.signal,
      method: "POST",
      json: {
        redeemId: checked.redeemId,
        username: normaliseUsername(input.username),
        registrationRequest,
      },
      omitToken: true,
    },
  );
  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse: registered.registrationResponse,
    password,
    keyStretching: keyStretching.profile,
  });
  const joined = await coreJson<RedeemFinished>(
    "/api/auth/invites/redeem/finish",
    {
      at: input.url,
      signal: input.signal,
      method: "POST",
      json: {
        redeemId: checked.redeemId,
        registrationRecord,
        keyStretching: keyStretching.version,
        binding: await inviteFinishBinding(
          sessionKey,
          host,
          registered.username,
          registrationRecord,
        ),
        client: input.client,
      } satisfies RedeemFinish,
      omitToken: true,
    },
  );
  if (
    !(await verifyInviteConfirmation(
      sessionKey,
      host,
      joined.token,
      joined.confirmation,
    ))
  ) {
    throw new SignInError("unconfirmed");
  }
  return joined;
}

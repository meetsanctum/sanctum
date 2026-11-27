import {
  formatInviteCode,
  inviteCheckBinding,
  inviteFinishBinding,
  keyStretching,
  newInviteSecret,
  splitInviteCode,
  verifyInviteConfirmation,
  type HostView,
  type InviteInfo,
  type RedeemChecked,
  type RedeemFinish,
  type RedeemFinished,
  type RedeemRegistered,
} from "@meetsanctum/auth-protocol";
import * as opaque from "@serenity-kit/opaque";

import { hostId, post, registration, type TestCore } from "./support.js";

// The inviting device draws the
// code's secret and registers it; the invited device proves it, then
// registers a password of its own. Fast key stretching, as for passwords.

const fast = {
  "argon2id-custom": { iterations: 1, memory: 1024, parallelism: 1 },
} as const;

const phone = { name: "Jonas's iPhone", platform: "ios" } as const;

// Adds a person through the API, as Settings → People does.
export async function addPerson(core: TestCore, token: string, name: string) {
  const added = await post(
    core,
    "/api/people/add",
    { name, colour: "#fcd2b3" },
    { token },
  );
  if (added.statusCode !== 200) {
    throw new Error(`adding ${name} failed: ${added.body}`);
  }
  return added.json() as { id: string; name: string };
}

// Makes a person an invite and returns the code the device would show.
export async function invite(
  core: TestCore,
  token: string,
  personId: string,
  call: { remoteAddress?: string } = {},
) {
  const secret = newInviteSecret();
  const started = registration(secret);
  const start = await post(
    core,
    "/api/auth/invites/start",
    { personId, registrationRequest: started.registrationRequest },
    { token, ...call },
  );
  if (start.statusCode !== 200) {
    return { response: start } as const;
  }
  const { registrationId, registrationResponse, lookup } = start.json();
  const finish = await post(
    core,
    "/api/auth/invites/finish",
    {
      registrationId,
      registrationRecord: started.finish(registrationResponse),
    },
    { token, ...call },
  );
  return {
    response: finish,
    code: `${lookup}${secret}`,
    info: finish.statusCode === 200 ? (finish.json() as InviteInfo) : null,
  } as const;
}

export async function checkInvite(
  core: TestCore,
  code: string,
  options: {
    sees?: HostView;
    remoteAddress?: string;
  } = {},
) {
  const call = { remoteAddress: options.remoteAddress };
  const { lookup, secret } = splitInviteCode(code);
  const login = opaque.client.startLogin({ password: secret });
  const start = await post(
    core,
    "/api/auth/invites/redeem/start",
    { lookup, startLoginRequest: login.startLoginRequest },
    call,
  );
  if (start.statusCode !== 200) {
    return { outcome: "refused" as const, response: start };
  }
  const { redeemId, loginResponse } = start.json();
  const proof = opaque.client.finishLogin({
    clientLoginState: login.clientLoginState,
    loginResponse,
    password: secret,
    keyStretching: fast,
  });
  if (!proof) {
    // A wrong code: the device stops here and sends nothing more.
    return { outcome: "failed-on-device" as const };
  }
  const sees = options.sees ?? { hostId, homeId: core.homeId, pin: null };
  const check = await post(
    core,
    "/api/auth/invites/redeem/check",
    {
      redeemId,
      finishLoginRequest: proof.finishLoginRequest,
      binding: await inviteCheckBinding(proof.sessionKey, sees),
    },
    call,
  );
  if (check.statusCode !== 200) {
    return { outcome: "refused" as const, response: check };
  }
  return {
    outcome: "checked" as const,
    checked: check.json<RedeemChecked>(),
    sessionKey: proof.sessionKey,
    sees,
    call,
  };
}

type CheckedInvite = Extract<
  Awaited<ReturnType<typeof checkInvite>>,
  { outcome: "checked" }
>;

export async function registerInvite(
  core: TestCore,
  { checked, sessionKey, sees, call }: CheckedInvite,
  username = "jonas",
  password = "staple battery horse",
) {
  const started = registration(password);
  const register = await post(
    core,
    "/api/auth/invites/redeem/register",
    {
      redeemId: checked.redeemId,
      username,
      registrationRequest: started.registrationRequest,
    },
    call,
  );
  if (register.statusCode !== 200) {
    return { outcome: "refused" as const, response: register, checked };
  }
  const registered = register.json<RedeemRegistered>();
  const registrationRecord = started.finish(registered.registrationResponse);
  return {
    outcome: "registered" as const,
    input: {
      redeemId: checked.redeemId,
      registrationRecord,
      keyStretching: keyStretching.version,
      binding: await inviteFinishBinding(
        sessionKey,
        sees,
        registered.username,
        registrationRecord,
      ),
      client: phone,
    },
  };
}

export async function finishInvite(
  core: TestCore,
  { checked, sessionKey, sees, call }: CheckedInvite,
  input: RedeemFinish,
) {
  const finish = await post(
    core,
    "/api/auth/invites/redeem/finish",
    input,
    call,
  );
  if (finish.statusCode !== 200) {
    return { outcome: "refused" as const, response: finish, checked };
  }
  const body = finish.json<RedeemFinished>();
  const confirmed = await verifyInviteConfirmation(
    sessionKey,
    sees,
    body.token,
    body.confirmation,
  );
  return {
    outcome: confirmed ? ("joined" as const) : ("unconfirmed" as const),
    body,
    checked,
  };
}

// Redeems a code as the invited device does, stopping at the first refusal.
export async function redeem(
  core: TestCore,
  code: string,
  options: Parameters<typeof checkInvite>[2] & {
    username?: string;
    password?: string;
  } = {},
) {
  const checked = await checkInvite(core, code, options);
  if (checked.outcome !== "checked") {
    return checked;
  }
  const registered = await registerInvite(
    core,
    checked,
    options.username,
    options.password,
  );
  if (registered.outcome !== "registered") {
    return registered;
  }
  return finishInvite(core, checked, registered.input);
}

export { formatInviteCode };

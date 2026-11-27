import {
  keyStretching,
  normalisePassword,
  passwordChangeBinding,
  type PasswordChooseFinish,
  type PasswordChooseStart,
  type PasswordFinish,
  type PasswordStart,
  type PasswordStarted,
  type RegistrationStarted,
} from "@meetsanctum/auth-protocol";

import { CoreError, coreJson, currentCredential } from "../core-fetch";
import { coreBaseUrl } from "../core-url";
import { getShell } from "../shell";
import { loadOpaque } from "./device";

// Changing your own password on this device: it proves the current one
// through OPAQUE and registers the new one in the same two calls, so neither
// leaves the device. The proof is bound to the host this device holds and to
// the new record. A wrong current password fails here, on the device, and
// nothing more is sent. Choosing a new one when you've forgotten the
// current one registers it alone: this device's sign-in is the proof.

export class PasswordChangeError extends Error {
  constructor(
    readonly code: "wrong_password" | "no_host" | "unchecked" | "unconfirmed",
  ) {
    super(code);
  }
}

const requestTimeoutMs = 10_000;

// Check that the device still holds the same host before each request.
// Each request's signal follows the caller's cancellation and a deadline.
function exchange(signal: AbortSignal | undefined) {
  const host = currentCredential();
  if (!host) throw new PasswordChangeError("no_host");
  // Over HTTPS the new registration response needs the shell's pinned
  // certificate check; plain HTTP, in development only, has none, as for
  // signing in.
  if (
    new URL(host.url).protocol !== "http:" &&
    (!host.pin || !getShell().trust)
  )
    throw new PasswordChangeError("unchecked");

  const requestSignal = () => {
    signal?.throwIfAborted();
    if (currentCredential() !== host || coreBaseUrl() !== host.url)
      throw new PasswordChangeError("no_host");
    const deadline = AbortSignal.timeout(requestTimeoutMs);
    return signal ? AbortSignal.any([signal, deadline]) : deadline;
  };
  return { host, requestSignal };
}

async function finishPassword(
  path: string,
  json: PasswordFinish | PasswordChooseFinish,
  signal: AbortSignal,
  callerSignal: AbortSignal | undefined,
) {
  try {
    await coreJson(path, { method: "POST", signal, json });
  } catch (error) {
    if (error instanceof CoreError || callerSignal?.aborted) throw error;
    throw new PasswordChangeError("unconfirmed");
  }
}

export async function changePassword(input: {
  current: string;
  next: string;
  signal?: AbortSignal;
}) {
  const { host, requestSignal } = exchange(input.signal);

  const opaque = await loadOpaque();
  input.signal?.throwIfAborted();
  const current = normalisePassword(input.current);
  const next = normalisePassword(input.next);
  const { clientLoginState, startLoginRequest } = opaque.client.startLogin({
    password: current,
  });
  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password: next });
  const started = await coreJson<PasswordStarted>("/api/auth/password/start", {
    method: "POST",
    signal: requestSignal(),
    json: { startLoginRequest, registrationRequest } satisfies PasswordStart,
  });
  const proof = opaque.client.finishLogin({
    clientLoginState,
    loginResponse: started.loginResponse,
    password: current,
    keyStretching: keyStretching.profile,
  });
  if (!proof) throw new PasswordChangeError("wrong_password");
  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse: started.registrationResponse,
    password: next,
    keyStretching: keyStretching.profile,
  });
  const binding = await passwordChangeBinding(
    proof.sessionKey,
    host,
    registrationRecord,
  );
  await finishPassword(
    "/api/auth/password/finish",
    {
      changeId: started.changeId,
      finishLoginRequest: proof.finishLoginRequest,
      binding,
      registrationRecord,
      keyStretching: keyStretching.version,
    } satisfies PasswordFinish,
    requestSignal(),
    input.signal,
  );
}

export async function choosePassword(input: {
  next: string;
  signal?: AbortSignal;
}) {
  const { requestSignal } = exchange(input.signal);
  const opaque = await loadOpaque();
  input.signal?.throwIfAborted();
  const next = normalisePassword(input.next);
  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password: next });
  const started = await coreJson<RegistrationStarted>(
    "/api/auth/password/choose/start",
    {
      method: "POST",
      signal: requestSignal(),
      json: { registrationRequest } satisfies PasswordChooseStart,
    },
  );
  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse: started.registrationResponse,
    password: next,
    keyStretching: keyStretching.profile,
  });
  await finishPassword(
    "/api/auth/password/choose/finish",
    {
      registrationId: started.registrationId,
      registrationRecord,
      keyStretching: keyStretching.version,
    } satisfies PasswordChooseFinish,
    requestSignal(),
    input.signal,
  );
}

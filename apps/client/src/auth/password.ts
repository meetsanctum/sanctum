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

// The host this device holds, checked as signing in checks it, and a
// signal for each request that ends with the caller's, after a while, or
// once the device holds another host.
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
  const signal = requestSignal();
  try {
    await coreJson("/api/auth/password/finish", {
      method: "POST",
      signal,
      json: {
        changeId: started.changeId,
        finishLoginRequest: proof.finishLoginRequest,
        binding,
        registrationRecord,
        keyStretching: keyStretching.version,
      } satisfies PasswordFinish,
    });
  } catch (error) {
    if (error instanceof CoreError || input.signal?.aborted) throw error;
    throw new PasswordChangeError("unconfirmed");
  }
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
  const signal = requestSignal();
  try {
    await coreJson("/api/auth/password/choose/finish", {
      method: "POST",
      signal,
      json: {
        registrationId: started.registrationId,
        registrationRecord,
        keyStretching: keyStretching.version,
      } satisfies PasswordChooseFinish,
    });
  } catch (error) {
    if (error instanceof CoreError || input.signal?.aborted) throw error;
    throw new PasswordChangeError("unconfirmed");
  }
}

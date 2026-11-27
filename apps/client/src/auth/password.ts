import {
  keyStretching,
  normalisePassword,
  passwordChangeBinding,
  type PasswordFinish,
  type PasswordStart,
  type PasswordStarted,
} from "@meetsanctum/auth-protocol";

import { CoreError, coreJson, currentCredential } from "../core-fetch";
import { coreBaseUrl } from "../core-url";
import { getShell } from "../shell";
import { loadOpaque } from "./device";

// Changing your own password on this device: it proves the current one
// through OPAQUE and registers the new one in the same two calls, so neither
// leaves the device. The proof is bound to the host this device holds and to
// the new record. A wrong current password fails here, on the device, and
// nothing more is sent.

export class PasswordChangeError extends Error {
  constructor(
    readonly code: "wrong_password" | "no_host" | "unchecked" | "unconfirmed",
  ) {
    super(code);
  }
}

const requestTimeoutMs = 10_000;

export async function changePassword(input: {
  current: string;
  next: string;
  signal?: AbortSignal;
}) {
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
    input.signal?.throwIfAborted();
    if (currentCredential() !== host || coreBaseUrl() !== host.url)
      throw new PasswordChangeError("no_host");
    const deadline = AbortSignal.timeout(requestTimeoutMs);
    return input.signal ? AbortSignal.any([input.signal, deadline]) : deadline;
  };

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

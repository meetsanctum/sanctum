import {
  keyStretching,
  normalisePassword,
  passwordChangeBinding,
  type PasswordFinish,
  type PasswordStart,
  type PasswordStarted,
} from "@meetsanctum/auth-protocol";

import { coreJson } from "../core-fetch";
import { loadOpaque } from "./device";
import { selectedHost } from "./session";

// Changing your own password on this device: it proves the current one
// through OPAQUE and registers the new one in the same two calls, so neither
// leaves the device. The proof is bound to the host this device holds and to
// the new record. A wrong current password fails here, on the device, and
// nothing more is sent.

export class PasswordChangeError extends Error {
  constructor(readonly code: "wrong_password" | "no_host") {
    super(code);
  }
}

export async function changePassword(input: {
  current: string;
  next: string;
  signal?: AbortSignal;
}) {
  const host = selectedHost();
  if (!host) throw new PasswordChangeError("no_host");
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
    signal: input.signal,
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
  await coreJson("/api/auth/password/finish", {
    method: "POST",
    signal: input.signal,
    json: {
      changeId: started.changeId,
      finishLoginRequest: proof.finishLoginRequest,
      binding: await passwordChangeBinding(
        proof.sessionKey,
        { hostId: host.hostId, homeId: host.homeId, pin: host.pin },
        registrationRecord,
      ),
      registrationRecord,
      keyStretching: keyStretching.version,
    } satisfies PasswordFinish,
  });
}

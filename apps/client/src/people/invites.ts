import {
  keyStretching,
  newInviteSecret,
  type CancelInvite,
  type InviteFinish,
  type InviteInfo,
  type InviteStart,
  type InviteStarted,
} from "@meetsanctum/auth-protocol";

import { loadOpaque } from "../auth/device";
import { coreJson } from "../core-fetch";

// Making a person's invite on this device: the core gives the code's first
// characters, this device draws the rest and registers the whole as a
// one-time password through OPAQUE, so the core never sees the code. It is
// shown once; a new one ends the last. A reset is the same for someone who
// signs in, whose password keeps working until the code is used.

// The code as the core reads it, without its dash.
export type MadeInvite = { code: string; info: InviteInfo };

export async function makeInvite(
  target: Omit<InviteStart, "registrationRequest">,
  signal?: AbortSignal,
): Promise<MadeInvite> {
  const opaque = await loadOpaque();
  signal?.throwIfAborted();
  const secret = newInviteSecret();
  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password: secret });
  const started = await coreJson<InviteStarted>("/api/auth/invites/start", {
    method: "POST",
    signal,
    json: { ...target, registrationRequest } satisfies InviteStart,
  });
  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse: started.registrationResponse,
    password: secret,
    keyStretching: keyStretching.profile,
  });
  const info = await coreJson<InviteInfo>("/api/auth/invites/finish", {
    method: "POST",
    signal,
    json: {
      registrationId: started.registrationId,
      registrationRecord,
      keyStretching: keyStretching.version,
    } satisfies InviteFinish,
  });
  return { code: `${started.lookup}${secret}`, info };
}

export async function cancelInvite(personId: string, inviteId: string) {
  await coreJson("/api/auth/invites/cancel", {
    method: "POST",
    json: { personId, inviteId } satisfies CancelInvite,
  });
}

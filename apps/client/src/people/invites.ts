import {
  keyStretching,
  newInviteSecret,
  newRecoveryCode,
  recoveryLookup,
  type CancelInvite,
  type InviteFinish,
  type InviteInfo,
  type InviteStart,
  type InviteStarted,
} from "@meetsanctum/auth-protocol";

import { loadOpaque } from "../auth/device";
import { coreJson } from "../core-fetch";

// This device draws a code's secret and registers it through OPAQUE.
// The core supplies the first characters of an invite or reset. For
// recovery, this device draws the entire code and sends only its digest
// and the registration. A new code replaces the previous one.

// The code as the core reads it, without its dash.
export type MadeInvite = { code: string; info: InviteInfo };

export async function makeInvite(
  target: Pick<InviteStart, "personId" | "kind" | "replacesInviteId">,
  signal?: AbortSignal,
  onSaving?: () => void,
): Promise<MadeInvite> {
  const opaque = await loadOpaque();
  const recovery = target.kind === "recovery";
  const secret = recovery ? newRecoveryCode() : newInviteSecret();
  signal?.throwIfAborted();
  const { clientRegistrationState, registrationRequest } =
    opaque.client.startRegistration({ password: secret });
  const registration = {
    personId: target.personId,
    replacesInviteId: target.replacesInviteId,
    registrationRequest,
  };
  const request: InviteStart =
    target.kind === "recovery"
      ? {
          ...registration,
          kind: target.kind,
          lookup: await recoveryLookup(secret),
        }
      : { ...registration, kind: target.kind };
  signal?.throwIfAborted();
  const started = await coreJson<InviteStarted>("/api/auth/invites/start", {
    method: "POST",
    signal,
    json: request,
  });
  signal?.throwIfAborted();
  const { registrationRecord } = opaque.client.finishRegistration({
    clientRegistrationState,
    registrationResponse: started.registrationResponse,
    password: secret,
    keyStretching: keyStretching.profile,
  });
  onSaving?.();
  const info = await coreJson<InviteInfo>("/api/auth/invites/finish", {
    method: "POST",
    signal,
    json: {
      registrationId: started.registrationId,
      registrationRecord,
      keyStretching: keyStretching.version,
    } satisfies InviteFinish,
  });
  return { code: recovery ? secret : `${started.lookup}${secret}`, info };
}

export async function cancelInvite(
  personId: string,
  inviteId: string,
  kind?: "recovery",
) {
  await coreJson("/api/auth/invites/cancel", {
    method: "POST",
    json: { personId, inviteId, kind } satisfies CancelInvite,
  });
}

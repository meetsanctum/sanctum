import * as opaque from "@serenity-kit/opaque";

import { AuthError } from "./errors.js";
import type { Limiter } from "./limits.js";

// The host's side of OPAQUE, for logins and invites alike. Each step spends
// one operation from the host's budget. The identifier is what a record is
// registered under and its key derived from: a login's username, an invite's
// own name (invites.ts in auth-protocol).

// OPAQUE's server functions throw on malformed messages.
function protocol<T>(step: () => T) {
  try {
    return step();
  } catch {
    throw new AuthError("invalid_request");
  }
}

export function createOpaqueServer(serverSetup: string, limiter: Limiter) {
  return {
    registrationResponse(identifier: string, registrationRequest: string) {
      limiter.work();
      return protocol(() =>
        opaque.server.createRegistrationResponse({
          serverSetup,
          userIdentifier: identifier,
          registrationRequest,
        }),
      ).registrationResponse;
    },

    // With no record, a made-up response that looks like a real one.
    startLogin(
      identifier: string,
      record: string | null,
      startLoginRequest: string,
    ) {
      limiter.work();
      return protocol(() =>
        opaque.server.startLogin({
          serverSetup,
          registrationRecord: record,
          startLoginRequest,
          userIdentifier: identifier,
        }),
      );
    },

    // The session key, or none when the device's last message does not check.
    finishLogin(serverLoginState: string, finishLoginRequest: string) {
      limiter.work();
      try {
        return opaque.server.finishLogin({
          serverLoginState,
          finishLoginRequest,
        }).sessionKey;
      } catch {
        return undefined;
      }
    },
  };
}

export type OpaqueServer = ReturnType<typeof createOpaqueServer>;

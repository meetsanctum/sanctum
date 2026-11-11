import type { AuthErrorCode } from "@meetsanctum/auth-protocol";

const statuses: Record<AuthErrorCode, number> = {
  invalid_request: 400,
  invalid_client_token: 401,
  sign_in_failed: 401,
  expired: 409,
  channel_mismatch: 403,
  forbidden: 403,
  needs_personal_client: 403,
  not_found: 404,
  claimed: 409,
  username_taken: 409,
  last_login: 409,
  too_many_attempts: 429,
  busy: 429,
  host_starting: 503,
};

// A refusal Auth's routes answer with its status and `{ error: code }`.
export class AuthError extends Error {
  readonly status: number;

  constructor(readonly code: AuthErrorCode) {
    super(code);
    this.status = statuses[code];
  }
}

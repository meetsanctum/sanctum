import { clientTokenPrefix } from "@meetsanctum/auth-protocol";
import { createHash, randomBytes } from "node:crypto";

// Tokens are 32 random bytes, base64url, with a type prefix. The core keeps
// only their SHA-256 hash: random tokens this long need no slow hash.

export function newClientToken() {
  return `${clientTokenPrefix}${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string) {
  return createHash("sha256").update(token).digest("base64url");
}

// The token from `Authorization: Bearer <token>`, if the header has one.
export function bearerToken(header: string | undefined) {
  const match = /^Bearer ([A-Za-z0-9_-]{1,200})$/.exec(header ?? "");
  return match?.[1];
}

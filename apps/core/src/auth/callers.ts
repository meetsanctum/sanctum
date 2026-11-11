import type { z } from "zod";

import type { ChangedBy } from "../activity/activity.js";
import type { Principal } from "./clients.js";
import { AuthError } from "./errors.js";

// Who calls the core's own routes, for Auth's routes and the other modules'
// alike. There are no roles or permissions between people, so every client
// may call them, shared ones too.

// The person on their own client, for what only they can do, such as
// changing their own password.
export function personalCaller(principal: Principal) {
  if (principal.client.kind !== "personal" || !principal.person) {
    throw new AuthError("needs_personal_client");
  }
  return principal.person.id;
}

// Who is behind a change, for the activity log: the person on a personal
// client, none on a shared one, and the client.
export function changedBy(principal: Principal): ChangedBy {
  return { personId: principal.person?.id, clientId: principal.client.id };
}

// A route's input, checked against its schema.
export function parseRequest<T extends z.ZodType>(
  schema: T,
  body: unknown,
): z.output<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AuthError("invalid_request");
  }
  return parsed.data;
}

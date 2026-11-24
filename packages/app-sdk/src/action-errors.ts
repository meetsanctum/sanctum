export const actionErrorCodes = [
  "forbidden",
  "not_found",
  "conflict",
  // The permission gate's refusal, which reaches an app when the core
  // refuses one of its calls for the actor behind it.
  "needs_approval",
  // An AI agent used its device-command allowance for the last minute, or a
  // turn asked for as many answers from the AI model as it may.
  "limited",
  // The home's AI model answers only within a turn, which this call isn't.
  "no_turn",
  // The turn this call belongs to is over: a newer request from the same
  // device took over, or its time ran out.
  "turn_ended",
] as const;
export type ActionErrorCode = (typeof actionErrorCodes)[number];

/**
 * A refusal an action reports to its caller, such as a mood that is no
 * longer there. The core answers with its code and logs it; anything else
 * an action throws is a failure.
 */
export class ActionError extends Error {
  constructor(
    readonly code: ActionErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = "ActionError";
  }
}

/**
 * Whether an app refused with an ActionError. The core goes by the error's
 * name and code rather than its class, so a refusal stays one from an app
 * package that brings its own copy of this SDK instead of the core's.
 */
export function isActionError(error: unknown): error is ActionError {
  return (
    error instanceof Error &&
    error.name === "ActionError" &&
    actionErrorCodes.includes((error as { code?: unknown }).code as never)
  );
}

const statuses = {
  invalid_request: 400,
  forbidden: 403,
  // The tier needs a person's approval: an app or a workflow can't do it on
  // its own.
  needs_approval: 403,
  not_found: 404,
  conflict: 409,
  app_failed: 500,
  // The app, or a device's driver app, is not running: paused or stopped.
  unavailable: 503,
  timeout: 504,
} as const;

export type ActionCallErrorCode = keyof typeof statuses;

// A refusal or failure of an action call, answered with its status and
// `{ error: code }`.
export class ActionCallError extends Error {
  readonly status: number;

  constructor(readonly code: ActionCallErrorCode) {
    super(code);
    this.status = statuses[code];
  }
}

export class TimedOut extends Error {}

// App code keeps running after a timeout, since JavaScript cannot stop it;
// its storage call ends, so it changes nothing more.
export function withTimeout<T>(work: Promise<T>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimedOut()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

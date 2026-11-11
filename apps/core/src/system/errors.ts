import { ManagerRefusal, ManagerUnavailable } from "../manager.js";

// System's refusals (updates, Restart and Shut down, Free up space), and the
// manager's answers as them.

export const systemErrorCodes = {
  invalid_version: 400,
  busy: 409,
  manager_unavailable: 503,
} as const;
export type SystemErrorCode = keyof typeof systemErrorCodes;

export class SystemError extends Error {
  readonly status: number;

  constructor(readonly code: SystemErrorCode) {
    super(code);
    this.status = systemErrorCodes[code];
  }
}

// The manager's answers as the core's refusals.
export async function relay<T>(call: () => Promise<T>) {
  try {
    return await call();
  } catch (error) {
    if (error instanceof ManagerUnavailable) {
      throw new SystemError("manager_unavailable");
    }
    if (error instanceof ManagerRefusal) {
      if (error.status === 409) throw new SystemError("busy");
      if (error.status === 400) throw new SystemError("invalid_version");
      // An answer the core cannot read or a call the manager does not know:
      // an older manager, until the update replaces it.
      throw new SystemError("manager_unavailable");
    }
    throw error;
  }
}

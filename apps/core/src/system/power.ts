import type { ChangedBy, RecordActivity } from "../activity/activity.js";
import { relay, SystemError } from "./errors.js";

// Restart and Shut down, from Settings → Status. The manager does it a
// moment after it answers, so the core tells every client first: their
// screens then say Restarting or Sanctum is off rather than Reconnecting.
// Each request goes in the activity log.

export type PowerAction = "restart" | "shutdown";

export type PowerManager = {
  power(action: PowerAction): Promise<void>;
};

export function createPower(options: {
  manager: PowerManager;
  record: RecordActivity;
  // Tells every client what is about to happen.
  announce: (action: PowerAction) => void;
}) {
  const { manager, record } = options;

  return {
    async request(by: ChangedBy, action: PowerAction) {
      try {
        await relay(() => manager.power(action));
      } catch (error) {
        if (error instanceof SystemError) {
          record({
            action: `sanctum.${action}`,
            outcome: "refused",
            reason: error.code,
            ...by,
          });
        }
        throw error;
      }
      record({ action: `sanctum.${action}`, outcome: "ok", ...by });
      options.announce(action);
    },
  };
}

export type Power = ReturnType<typeof createPower>;

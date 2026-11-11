import type { ChangedBy, RecordActivity } from "../activity/activity.js";
import type { SpacePlan } from "../manager.js";
import { relay, SystemError } from "./errors.js";

// Free up space, from Settings → Status: the manager removes the old
// versions nothing needs and says what the disk freed. Each request goes in
// the activity log, with how much.

export type SpaceManager = {
  spacePlan(): Promise<SpacePlan>;
  freeSpace(): Promise<{ freed: number | null }>;
};

export function createSpace(options: {
  manager: SpaceManager;
  record: RecordActivity;
}) {
  const { manager, record } = options;

  return {
    plan: () => relay(() => manager.spacePlan()),

    async free(by: ChangedBy) {
      try {
        const { freed } = await relay(() => manager.freeSpace());
        record({
          action: "sanctum.space.free",
          outcome: "ok",
          ...by,
          detail: { freed },
        });
        return { freed };
      } catch (error) {
        if (error instanceof SystemError) {
          record({
            action: "sanctum.space.free",
            outcome: "refused",
            reason: error.code,
            ...by,
          });
        }
        throw error;
      }
    },
  };
}

export type Space = ReturnType<typeof createSpace>;

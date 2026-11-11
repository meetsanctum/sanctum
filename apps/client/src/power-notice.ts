import type { LiveMessage, LiveSystem } from "@meetsanctum/app-sdk";
import type { createLiveFeed } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

import type { CoreStatus } from "./core-status";

// Sanctum about to restart or shut down, as the core tells every client
// before it goes (LiveSystem): the connection veil says Restarting, Shutting
// down or Sanctum is off rather than Reconnecting, on every screen, the one
// that asked and the others. It holds until Sanctum has gone and answers
// again, or for a minute if it never goes.

/** How long Sanctum may keep answering after it said it was going before the screens stop waiting for it. */
export const goneWithinMs = 60_000;

export type Going = { action: LiveSystem["going"]; away: boolean };

export function useGoing(
  live: ReturnType<typeof createLiveFeed>,
  core: CoreStatus["state"],
) {
  const [going, setGoing] = useState<Going>();

  useEffect(
    () =>
      live.subscribe({
        message(message: LiveMessage) {
          if (message.type === "system") {
            // The local POST and the broadcast can acknowledge the same
            // request; a late answer must not reset a disconnect already seen.
            setGoing((current) =>
              current?.action === message.going
                ? current
                : { action: message.going, away: false },
            );
          }
        },
      }),
    [live],
  );

  // Gone once the core stops answering; back once it answers again.
  useEffect(() => {
    if (!going) return;
    if (core === "offline" && !going.away) setGoing({ ...going, away: true });
    if (core === "online" && going.away) setGoing(undefined);
  }, [core, going]);

  // A restart or shutdown that never happened.
  useEffect(() => {
    if (!going || going.away) return;
    const timer = setTimeout(() => setGoing(undefined), goneWithinMs);
    return () => clearTimeout(timer);
  }, [going]);

  return going;
}

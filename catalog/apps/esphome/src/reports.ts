import type { AppContext, MediaActivity } from "@meetsanctum/app-sdk";
import type { TelemetryEvent } from "esphome-client";

import type { Session } from "./connection.js";
import { signalOf, type Mapping } from "./entities.js";
import type { Facts } from "./facts.js";
import { stateOf } from "./states.js";

// What a device says, told to the core: each part's state, each press once,
// and its Wi-Fi signal kept for its page.

/**
 * Reports one thing a session's device said, read by that session's own
 * parts.
 */
export function report(
  ctx: AppContext,
  facts: Facts,
  mac: string,
  mapping: Mapping,
  event: TelemetryEvent,
  session: Session,
  activities: Map<string, MediaActivity>,
) {
  // A state event names its entity by its key, which a type keeps apart.
  if (
    event.type === "sensor" &&
    event.key === signalOf(session.entities)?.key
  ) {
    if (
      typeof event.state === "number" &&
      Number.isFinite(event.state) &&
      !event.missingState
    ) {
      facts.signal(mac, Math.round(event.state)).catch((error: unknown) => {
        ctx.log(`could not save signal for ${mac} (${String(error)})`);
      });
    }
    return;
  }
  const mapped = mapping.mapped.find(
    (each) => each.entity.type === event.type && each.entity.key === event.key,
  );
  if (!mapped) return;
  const capability = mapped.capability.id;
  const sent =
    event.type === "event"
      ? typeof event.eventType === "string" &&
        (mapped.capability.features as { actions: string[] }).actions.includes(
          event.eventType,
        )
        ? ctx.devices.press({
            key: mac,
            capability,
            action: event.eventType,
          })
        : null
      : (() => {
          const now = stateOf(mapped, event, activities.get(capability));
          if (now && "activity" in now) {
            activities.set(capability, now.activity);
          }
          return now
            ? ctx.devices.report({
                key: mac,
                states: { [capability]: now },
              })
            : null;
        })();
  sent?.catch((error: unknown) => {
    ctx.log(`could not report ${mac} (${String(error)})`);
  });
}

import type {
  ActivityInfo,
  AppInfo,
  AppSettings,
  DashboardInfo,
  LiveActivity,
  LiveApp,
  LiveAppRemoved,
  LiveDashboards,
  LiveDevice,
  LiveEntity,
  LiveOffer,
  LivePairing,
  LivePins,
  LivePlaces,
  LivePress,
  LiveSettings,
  LiveSystem,
  HardwareOffer,
  Hearing,
  LiveHearing,
  PairingInfo,
  Places,
} from "@meetsanctum/app-sdk";

import type { Gate, Rule } from "./app-host/gate.js";
import type { Principal } from "./auth/clients.js";
import type { LiveConnections } from "./auth/live.js";
import { dashboardRules } from "./dashboards/dashboards.js";
import type { DeviceChange } from "./devices/devices.js";
import { viewOf } from "./devices/views.js";
import { pairingRules } from "./devices/pairing.js";
import type { Press } from "./devices/presses.js";
import type { EntityChange } from "./entities/entities.js";
import { pinRules } from "./pins/pins.js";

// What the core pushes to clients over /api/live once they are ready, in the
// shapes @meetsanctum/app-sdk gives them: each connection gets only what the
// principal it authenticated as may see. A connection closes as its person
// is removed or its client revoked, so an update asks only the gate's rules
// for each one still open, never the database. A client opens the socket
// first and then reads GET /api/devices, /api/places, /api/entities,
// /api/dashboards and /api/pins, so nothing falls between the two. Remotes'
// presses, the activity log's entries and a restart or shutdown about to
// happen go out as they happen. Every client hears all of it, shared ones
// too.

export function createLiveUpdates(
  connections: Pick<LiveConnections, "publish">,
  gate: Pick<Gate, "admitConnected">,
) {
  function admitted(principal: Principal, rule: Rule) {
    try {
      return gate.admitConnected(principal, rule);
    } catch {
      return undefined;
    }
  }

  const reads = (principal: Principal) =>
    admitted(principal, { tier: "read" }) !== undefined;

  return {
    device({ id, before, after }: DeviceChange) {
      connections.publish((principal): LiveDevice | undefined => {
        if (!reads(principal)) {
          return undefined;
        }
        const was = before && viewOf(before);
        const is = after && viewOf(after);
        return was || is ? { type: "device", id, device: is } : undefined;
      });
    },

    // Captured too: the page that captures it waits for it here.
    press({ device, capability, action, at, isCaptured }: Press) {
      connections.publish((principal): LivePress | undefined => {
        return reads(principal) &&
          device.capabilities.some((each) => each.id === capability)
          ? {
              type: "press",
              device: device.id,
              capability,
              action,
              at: at.toISOString(),
              isCaptured,
            }
          : undefined;
      });
    },

    places(places: Places) {
      connections.publish((principal): LivePlaces | undefined =>
        reads(principal) ? { type: "places", places } : undefined,
      );
    },

    entity({ app, key, before, after }: EntityChange) {
      connections.publish((principal): LiveEntity | undefined => {
        return reads(principal) && (before || after)
          ? {
              type: "entity",
              app,
              key,
              entity: after,
              was: before?.type ?? null,
            }
          : undefined;
      });
    },

    // An app's grants changed, and with them whether it runs, as every
    // client lists it (GET /api/apps), so each shell follows it at once.
    app(app: AppInfo) {
      connections.publish((principal): LiveApp | undefined =>
        reads(principal) ? { type: "app", app } : undefined,
      );
    },

    // Someone removed an app, which every shell drops at once.
    appRemoved(app: string) {
      connections.publish((principal): LiveAppRemoved | undefined =>
        reads(principal) ? { type: "app.removed", app } : undefined,
      );
    },

    settings(app: string, settings: AppSettings) {
      connections.publish((principal): LiveSettings | undefined =>
        reads(principal) ? { type: "settings", app, settings } : undefined,
      );
    },

    dashboards(dashboards: DashboardInfo[]) {
      connections.publish((principal): LiveDashboards | undefined =>
        admitted(principal, dashboardRules.read)
          ? { type: "dashboards", dashboards }
          : undefined,
      );
    },

    pins(apps: string[]) {
      connections.publish((principal): LivePins | undefined =>
        admitted(principal, pinRules.read) ? { type: "pins", apps } : undefined,
      );
    },

    activity(entry: ActivityInfo) {
      connections.publish((principal): LiveActivity | undefined =>
        reads(principal) ? { type: "activity", entry } : undefined,
      );
    },

    pairing(pairing: PairingInfo) {
      connections.publish((principal): LivePairing | undefined =>
        admitted(principal, pairingRules.read)
          ? { type: "pairing", pairing }
          : undefined,
      );
    },

    // A Zigbee stick plugged in, offering its app, or that ended.
    offer(offer: HardwareOffer | null) {
      connections.publish((principal): LiveOffer | undefined =>
        reads(principal) ? { type: "offer", offer } : undefined,
      );
    },

    // How speech recognition is doing, for the Assistant's app client.
    hearing(hearing: Hearing) {
      connections.publish((principal): LiveHearing | undefined =>
        reads(principal) ? { type: "hearing", hearing } : undefined,
      );
    },

    // Sanctum is about to restart or shut down (system/power.ts).
    system(going: LiveSystem["going"]) {
      connections.publish((principal): LiveSystem | undefined =>
        reads(principal) ? { type: "system", going } : undefined,
      );
    },
  };
}

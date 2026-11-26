import type { AppHost } from "./app-host/host.js";
import type { Blobs } from "./blobs/blobs.js";
import type { Dashboards } from "./dashboards/dashboards.js";
import type { DeviceChange, Devices } from "./devices/devices.js";
import type { Holds } from "./devices/holds.js";
import type { Motion } from "./devices/motion.js";
import type { Pairing } from "./devices/pairing.js";
import type { EventBus } from "./event-bus.js";
import type { History } from "./history/history.js";
import type { createLiveUpdates } from "./live-updates.js";
import type { Speech } from "./speech/speech.js";
import type { Listening } from "./speech/listening.js";
import type { Workflows } from "./workflows/workflows.js";

// The core's event followers, in delivery order. Handlers call through so
// a test that replaces a module's method still reaches it.
export function setCoreFollowers(
  eventBus: EventBus,
  {
    apps,
    blobs,
    dashboards,
    devices,
    history,
    holds,
    listening,
    live,
    motion,
    pairing,
    speech,
    workflows,
  }: {
    apps: Pick<AppHost, "eventsForApps">;
    blobs: Pick<Blobs, "deviceChanged">;
    dashboards: Pick<Dashboards, "deviceChanged">;
    devices: Pick<Devices, "renameAll">;
    history: Pick<History, "deviceChanged">;
    holds: Pick<Holds, "pressed">;
    listening: Pick<Listening, "deviceGone">;
    live: Pick<
      ReturnType<typeof createLiveUpdates>,
      "device" | "press" | "places" | "entity"
    >;
    motion: Pick<Motion, "follower">;
    pairing: Pick<Pairing, "removed" | "refresh">;
    speech?: Pick<Speech, "deviceChanged">;
    workflows: Pick<
      Workflows,
      | "deviceChanged"
      | "pressed"
      | "entityChanged"
      | "appEvent"
      | "motionChanged"
    >;
  },
) {
  eventBus.setFollowers([
    ["holds", { "device.pressed": (press) => holds.pressed(press) }],
    [
      "live updates",
      {
        "device.changed": (change) => live.device(change),
        "device.pressed": (press) => live.press(press),
        "places.changed": ({ after }) => live.places(after),
        "entity.changed": (change) => live.entity(change),
      },
    ],
    ["events for apps", apps.eventsForApps],
    // A speaker that goes takes its run with it.
    [
      "listening",
      {
        "device.changed": ({ id, after }: DeviceChange) => {
          if (after === null) listening.deviceGone(id);
        },
      },
    ],
    // Speaker registrations change whether the home needs speech.
    ...(speech
      ? ([
          [
            "speech",
            {
              "device.changed": (change: DeviceChange) =>
                speech.deviceChanged(change),
            },
          ],
        ] as const)
      : []),
    [
      "pairing",
      {
        "device.changed"({ id, before, after }) {
          if (after === null) pairing.removed(id);
          // A device added or removed leaves or rejoins what was found.
          if (before === null || after === null) pairing.refresh();
        },
      },
    ],
    // Devices named after their room follow it.
    ["device names", { "places.changed": () => devices.renameAll() }],
    // Before workflows, which follow what it makes of a place's sensors.
    ["motion", motion.follower],
    [
      "workflows",
      {
        "device.changed": (change) => workflows.deviceChanged(change),
        // Not one a capture holds.
        "device.pressed"(press) {
          if (!press.isCaptured) workflows.pressed(press);
        },
        "entity.changed": (change) => workflows.entityChanged(change),
        "app.emitted": (event) => workflows.appEvent(event),
        "motion.changed": (change) => workflows.motionChanged(change),
      },
    ],
    [
      "dashboards",
      { "device.changed": (change) => dashboards.deviceChanged(change) },
    ],
    [
      "history",
      { "device.changed": (change) => history.deviceChanged(change) },
    ],
    // Which pictures players name, so the rest can go.
    [
      "drivers' pictures",
      { "device.changed": (change) => blobs.deviceChanged(change) },
    ],
  ]);
}

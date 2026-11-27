import { isDeepStrictEqual } from "node:util";

import { moodType } from "@meetsanctum/app-sdk";

import type { AppHost } from "./app-host/host.js";
import type { Blobs } from "./blobs/blobs.js";
import type { Dashboards } from "./dashboards/dashboards.js";
import type { EntityChange } from "./entities/entities.js";
import type { DeviceChange, Devices } from "./devices/devices.js";
import type { Holds } from "./devices/holds.js";
import type { Motion } from "./devices/motion.js";
import type { Pairing } from "./devices/pairing.js";
import type { EventBus, EventBusFollower } from "./event-bus.js";
import type { History } from "./history/history.js";
import type { createLiveUpdates } from "./live-updates.js";
import type { Speech } from "./speech/speech.js";
import { hasListeningPart } from "./speech/hearing.js";
import type { Learning } from "./speech/learning.js";
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
    learning,
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
    learning?: Pick<Learning, "changed" | "speakersChanged">;
    listening: { deviceChanged(change: DeviceChange): void };
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
  // Only names affect the lesson. Speaker registrations affect service demand.
  const recognition: EventBusFollower | undefined = learning && {
    "device.changed": ({ before, after }) => {
      if (hasListeningPart(before) !== hasListeningPart(after)) {
        learning.speakersChanged();
      }
      const lightName = (device: DeviceChange["before"]) =>
        device?.capabilities.some((part) => part.kind === "light")
          ? device.name
          : undefined;
      if (lightName(before) !== lightName(after)) learning.changed();
    },
    "places.changed": ({ before, after }) => {
      const names = (places: typeof before) =>
        [places.rooms, places.floors].map((list) =>
          list.map(({ name }) => name).sort(),
        );
      if (!isDeepStrictEqual(names(before), names(after))) learning.changed();
    },
    // A mood added, renamed or gone, of the standard type whatever app keeps it.
    "entity.changed": ({ before, after }) => {
      const moodName = (entity: EntityChange["before"]) =>
        entity?.type === moodType.id ? entity.name : undefined;
      if (moodName(before) !== moodName(after)) learning.changed();
    },
  };
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
    // A speaker that goes or mutes takes its run with it.
    [
      "listening",
      {
        "device.changed": (change) => listening.deviceChanged(change),
      },
    ],
    ...(recognition ? ([["speech recognition", recognition]] as const) : []),
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

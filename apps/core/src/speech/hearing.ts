import {
  spokenRequestsPermission,
  type RequestLanguage,
} from "@meetsanctum/app-sdk";

import type { NewActivityEntry } from "../activity/activity.js";
import type { AppHost } from "../app-host/host.js";
import type { Devices } from "../devices/devices.js";
import type { PlacesModule } from "../places/places.js";
import { createListening } from "./listening.js";
import type { Speech } from "./speech.js";
import { createSpokenRequests, type Transcriber } from "./spoken.js";

// Smart speakers' runs, which their drivers open as they hear their wake
// word (listening.ts), and the requests someone makes of them (spoken.ts).

function listens(device: ReturnType<Devices["get"]>) {
  return device?.capabilities.find(
    (part) => part.kind === "audio" && part.features.listens,
  );
}

export function assembleHearing(options: {
  devices: Devices;
  places: Pick<PlacesModule, "list">;
  apps: () => AppHost;
  speech: () => Speech | undefined;
  // The core declines runs when no transcriber is available.
  transcriber?: () => Transcriber | null;
  language?: () => RequestLanguage;
  record: (entry: NewActivityEntry) => void;
  now?: () => number;
  log: (message: string) => void;
}) {
  const { devices, places, apps, log } = options;
  const spoken = createSpokenRequests({
    transcriber: options.transcriber ?? (() => null),
    language: options.language ?? (() => "en"),
    speaker(id) {
      const device = devices.get(id);
      const capability = listens(device);
      if (!device || !capability) return null;
      const room =
        device.roomId === null
          ? undefined
          : places.list().rooms.find((each) => each.id === device.roomId);
      return {
        name: device.name,
        capability: capability.id,
        room: room ? { id: room.id, name: room.name } : null,
      };
    },
    drives: (driver, id) =>
      devices.get(id)?.driver === driver &&
      apps().isRunning(driver) &&
      (apps().holds(driver)?.granted.includes(spokenRequestsPermission) ??
        false),
    requests: {
      answers: () => apps().answersRequests(),
      hasRoom: (key) => apps().hasRequestRoom(key),
      ask: (request) => apps().ask(request),
      forget: (key) => apps().forgetRequests(key),
    },
    speech: options.speech,
    record: options.record,
    now: options.now,
    log,
  });
  const listening = createListening({
    idFor: (driver, key) => devices.idFor(driver, key),
    listens: (id) => Boolean(listens(devices.get(id))),
    hearer: spoken.hearer,
    refused: spoken.refused,
    now: options.now,
    log,
  });
  return {
    listening: {
      ...listening,
      driverStopped(driver: string) {
        listening.driverStopped(driver);
        spoken.driverStopped(driver);
      },
      stop() {
        listening.stop();
        spoken.stop();
      },
      /** A device went: its run and its request end. */
      deviceGone(id: string) {
        listening.deviceGone(id);
        spoken.deviceGone(id);
      },
    },
    spoken,
    /** Whether a device is a smart speaker that listens. */
    isSpeaker: (id: string) => Boolean(listens(devices.get(id))),
  };
}

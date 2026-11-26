import type { RequestLanguage } from "@meetsanctum/app-sdk";

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
  return (
    device?.capabilities.some(
      (part) => part.kind === "audio" && part.features.listens,
    ) ?? false
  );
}

export function assembleHearing(options: {
  devices: Devices;
  places: Pick<PlacesModule, "list">;
  apps: () => AppHost;
  speech: () => Speech | undefined;
  // What hears words in a run's sound: none yet, so every run is refused.
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
      if (!device) return null;
      const room =
        device.roomId === null
          ? undefined
          : places.list().rooms.find((each) => each.id === device.roomId);
      return {
        name: device.name,
        room: room ? { id: room.id, name: room.name } : null,
      };
    },
    drives: (driver, id) =>
      devices.get(id)?.driver === driver && apps().isRunning(driver),
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
    listens: (id) => listens(devices.get(id)),
    hearer: (id) => spoken.hearer(id),
    refused: (id, refusal) => spoken.refused(id, refusal),
    now: options.now,
    log,
  });
  return {
    listening: {
      ...listening,
      /** A device went: its run and its request end. */
      deviceGone(id: string) {
        listening.deviceGone(id);
        spoken.deviceGone(id);
      },
    },
    spoken,
    /** Whether a device is a smart speaker that listens. */
    isSpeaker: (id: string) => listens(devices.get(id)),
  };
}

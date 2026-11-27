import type { RequestLanguage } from "@meetsanctum/app-sdk";

import type { NewActivityEntry } from "../activity/activity.js";
import type { AppHost } from "../app-host/host.js";
import type { DeviceChange, Devices } from "../devices/devices.js";
import type { PlacesModule } from "../places/places.js";
import type { NotHearing } from "./learning.js";
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

export function hasListeningPart(device: ReturnType<Devices["get"]>) {
  return Boolean(listens(device));
}

function canListen(device: ReturnType<Devices["get"]>) {
  const part = listens(device);
  return part?.kind === "audio" && part.observed?.muted !== true;
}

export function assembleHearing(options: {
  devices: Devices;
  places: Pick<PlacesModule, "list">;
  apps: () => AppHost;
  speech: () => Speech | undefined;
  // The core declines runs when no transcriber is available.
  transcriber?: () => Transcriber | null;
  // Why nothing hears runs, when nothing does.
  notHearing?: () => NotHearing;
  language?: () => RequestLanguage;
  // What a speaker says for speech outside the Assistant's sentences.
  notUnderstood?: (language: RequestLanguage) => string | null;
  record: (entry: NewActivityEntry) => void;
  now?: () => number;
  log: (message: string) => void;
}) {
  const { devices, places, apps, log } = options;
  const spoken = createSpokenRequests({
    transcriber: options.transcriber ?? (() => null),
    notHearing: options.notHearing ?? (() => "no_speech_to_text"),
    language: options.language ?? (() => "en"),
    notUnderstood: options.notUnderstood ?? (() => null),
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
    listens: (id) => canListen(devices.get(id)),
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
      deviceChanged({ before, after, id }: DeviceChange) {
        if (after === null) {
          listening.deviceGone(id);
          spoken.deviceGone(id);
        } else if (canListen(before) && !canListen(after)) {
          listening.deviceGone(id);
          spoken.cancelDevice(id);
        }
      },
      cancelRuns() {
        listening.cancelRuns();
        spoken.stop();
      },
    },
    spoken,
    /** Whether a device is a smart speaker that listens. */
    isSpeaker: (id: string) => hasListeningPart(devices.get(id)),
  };
}

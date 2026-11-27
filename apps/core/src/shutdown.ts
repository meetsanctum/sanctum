import type { CoreSteps } from "./lifecycle.js";
import type { assembleHearing } from "./speech/hearing.js";
import type { createAppHost } from "./app-host/host.js";
import type { createAppList } from "./app-host/app-list.js";
import type { createAsking } from "./devices/asking.js";
import type { createBlobs } from "./blobs/blobs.js";
import type { createDevices } from "./devices/devices.js";
import type { createEventBus } from "./event-bus.js";
import type { createFirmware } from "./devices/firmware.js";
import type { createHistory } from "./history/history.js";
import type { createHolds } from "./devices/holds.js";
import type { createManagerAuditCopy } from "./activity/manager-audit.js";
import type { createModels } from "./models/models.js";
import type { createPairing } from "./devices/pairing.js";
import type { createRoomWaits } from "./app-host/room-waits.js";
import type { createSightings } from "./discovery/sightings.js";
import type { createTurns } from "./models/turns.js";
import type { createWorkflows } from "./workflows/workflows.js";

export function assembleShutdown({
  workflows,
  hardwareOffers,
  deviceOffers,
  roomWaits,
  apps,
  listening,
  turns,
  stopSpeech,
  sightings,
  managerAudit,
  appDeleting,
  devices,
  holds,
  listTurns,
  asking,
  models,
  firmware,
  eventBus,
  blobs,
  history,
  pairing,
}: {
  workflows: Pick<ReturnType<typeof createWorkflows>, "interrupt" | "close">;
  hardwareOffers: Pick<
    ReturnType<typeof createAppList>["hardwareOffers"],
    "interrupt" | "close"
  >;
  deviceOffers: Pick<
    ReturnType<typeof createAppList>["deviceOffers"],
    "interrupt" | "close"
  >;
  roomWaits: Pick<ReturnType<typeof createRoomWaits>, "interrupt" | "close">;
  apps: Pick<ReturnType<typeof createAppHost>, "stopRequests" | "close">;
  listening: Pick<
    ReturnType<typeof assembleHearing>["listening"],
    "stop" | "clearFinished"
  >;
  turns: Pick<ReturnType<typeof createTurns>, "close">;
  stopSpeech: () => Promise<void>;
  sightings: Pick<ReturnType<typeof createSightings>, "close"> | undefined;
  managerAudit:
    Pick<ReturnType<typeof createManagerAuditCopy>, "close"> | undefined;
  appDeleting: Pick<ReturnType<typeof createAppList>["appDeleting"], "close">;
  devices: Pick<ReturnType<typeof createDevices>, "closing" | "close">;
  holds: Pick<ReturnType<typeof createHolds>, "close">;
  listTurns: Pick<ReturnType<typeof createAppList>["listTurns"], "settled">;
  asking: Pick<ReturnType<typeof createAsking>, "close">;
  models: Pick<ReturnType<typeof createModels>, "stop">;
  firmware: Pick<ReturnType<typeof createFirmware>, "close">;
  eventBus: Pick<ReturnType<typeof createEventBus>, "close">;
  blobs: Pick<ReturnType<typeof createBlobs>, "close">;
  history: Pick<ReturnType<typeof createHistory>, "close">;
  pairing: Pick<ReturnType<typeof createPairing>, "stop">;
}) {
  // Stop new workflow runs and offer checks before waiting on shutdown.
  const stopNewWork = [
    ["workflows", () => workflows.interrupt()],
    ["look for sticks", () => hardwareOffers.interrupt()],
    ["check Add devices' offers", () => deviceOffers.interrupt()],
    ["try updates that wait for room", () => roomWaits.interrupt()],
    ["stop Assistant requests", () => apps.stopRequests()],
    ["stop smart speakers' runs", () => listening.stop()],
    ["take no more turns with the AI model", () => turns.close()],
  ] as const satisfies CoreSteps["stopNewWork"];
  // Nothing goes to a device again while the apps stop. Devices' and
  // firmware's deadlines are the last that change a device, so the bus closes
  // after them, and history then records that nothing is known from then on.
  const stoppingSteps = [
    ["stop announcements", stopSpeech],
    ["stop discovery", () => sightings?.close()],
    ["stop the manager's audit", () => managerAudit?.close()],
    ["stop removed apps' deadlines", () => appDeleting.close()],
    ["finish looking for sticks", () => hardwareOffers.close()],
    ["stop Add devices' offers", () => deviceOffers.close()],
    ["stop trying updates that wait for room", () => roomWaits.close()],
    ["stop commands to devices", () => devices.closing()],
    ["stop workflows", () => workflows.close()],
    ["stop holds", () => holds.close()],
    ["finish changes to apps", () => listTurns.settled()],
    ["stop adding and repairing that ask", () => asking.close()],
    ["stop the app host", () => apps.close()],
    ["clear finished smart speaker runs", () => listening.clearFinished()],
    ["stop watching the AI model", () => models.stop()],
    ["stop devices", () => devices.close()],
    ["stop firmware", () => firmware.close()],
    ["close the bus", () => eventBus.close()],
    ["let drivers' pictures go", () => blobs.close()],
    ["stop history", () => history.close()],
    ["stop pairing", () => pairing.stop()],
  ] as const satisfies CoreSteps["stopping"];
  return { stopNewWork, stoppingSteps };
}

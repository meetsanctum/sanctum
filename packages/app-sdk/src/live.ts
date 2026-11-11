import type { ActivityInfo } from "./activity.js";
import type { AppInfo } from "./index.js";
import type { DashboardInfo } from "./dashboards.js";
import type { DeviceInfo } from "./devices.js";
import type { EntityInfo } from "./entities.js";
import type { PairingInfo } from "./pairing.js";
import type { Places } from "./places.js";
import type { AppSettings } from "./settings.js";

// What the core pushes to clients over /api/live once they are ready, each
// connection only what its principal may see.

/** A device changed; `device` is null when the client can no longer see it. */
export type LiveDevice = {
  type: "device";
  id: string;
  device: DeviceInfo | null;
};

/**
 * A remote was pressed, once for each press, as it happens: to every
 * client that may see the device, during a capture too.
 */
export type LivePress = {
  type: "press";
  device: string;
  capability: string;
  action: string;
  at: string;
  /** Whether the core held this press back from workflows and apps. */
  isCaptured: boolean;
};

/** The home's floors, rooms or zones changed. */
export type LivePlaces = { type: "places"; places: Places };

/** An app published an entity; `entity` is null when it is gone, or the client can no longer see it. */
export type LiveEntity = {
  type: "entity";
  app: string;
  key: string;
  entity: EntityInfo | null;
  /** Its type before this change, if the client could see it then, so a removal reaches only those who had it. */
  was: string | null;
};

/** Adding devices changed. */
export type LivePairing = { type: "pairing"; pairing: PairingInfo };

/** Someone changed an app's settings: all of them, with its defaults. */
export type LiveSettings = {
  type: "settings";
  app: string;
  settings: AppSettings;
};

/**
 * An app's grants changed on some client, and with them whether it runs: the
 * app as GET /api/apps lists it. Only the shell gets it, which hands the
 * app's pages a client with what it holds now.
 */
export type LiveApp = { type: "app"; app: AppInfo };

/** The home's dashboards changed: all of them, in their order. Only the shell gets it. */
export type LiveDashboards = {
  type: "dashboards";
  dashboards: DashboardInfo[];
};

/** The household's pinned apps changed: all of them, in their order. Only the shell gets it. */
export type LivePins = { type: "pins"; apps: string[] };

/**
 * An entry of the activity log, once it has committed, and again under the
 * same id when it changes: a run ends, a device does not answer, a command
 * joins it, or what a press or run led to grows.
 */
export type LiveActivity = { type: "activity"; entry: ActivityInfo };

/**
 * Sanctum is about to restart or shut down, as someone asked in Settings →
 * Status: to every client, so its screen says so while it is away. Only the
 * shell gets it.
 */
export type LiveSystem = { type: "system"; going: "restart" | "shutdown" };

export type LiveMessage =
  | LiveDevice
  | LivePress
  | LivePlaces
  | LiveEntity
  | LivePairing
  | LiveSettings
  | LiveApp
  | LiveDashboards
  | LivePins
  | LiveActivity
  | LiveSystem;

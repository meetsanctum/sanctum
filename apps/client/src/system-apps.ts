import type { AppInfo } from "@meetsanctum/app-sdk";
import type { PageParams } from "@meetsanctum/ui-sdk";

import { agentsTitle, canUseTitle } from "./agents/words";
import { modelsTitle } from "./models/words";
import type { SetupTarget } from "./setup-guide";

// The system apps the shell brings, Settings and Automations, and the names
// and titles of Settings' pages: what the rest of the shell needs to open
// and name them, kept apart from their pages, which load the first time one
// opens (Home.tsx).

export const settingsApp = {
  id: "sanctum.settings",
  name: "Settings",
  icon: { glyph: "settings", color: "graphite" },
} as const;

export const automationsApp = {
  id: "sanctum.automations",
  name: "Automations",
  icon: { glyph: "sparkles", color: "blossom" },
} as const;

export const householdSettingsPage = "household";
export const roomsSettingsPage = "rooms";
export const devicesSettingsPage = "devices";
export const maintenanceSettingsPage = "maintenance";
export const activitySettingsPage = "activity";
export const appsSettingsPage = "apps";
/** Settings' page for one app, by its id. */
export const appSettingsPage = "app";
export const agentsSettingsPage = "agents";
export const canUseSettingsPage = "ai-can-use";
export const modelsSettingsPage = "ai-models";
export const clientsSettingsPage = "clients";
export const systemSettingsPage = "system";

export const roomsTitle = "Rooms and Floors";

// An app's settings page's title, which Back on a page over it names too.
export function appSettingsTitle(name: string) {
  return `${name} Settings`;
}

/** The page each step of the setup guide opens and starts. */
export const setupPage: Record<SetupTarget, string> = {
  "add-room": roomsSettingsPage,
  "add-devices": devicesSettingsPage,
  household: householdSettingsPage,
};

const pageTitles: Record<string, string> = {
  main: "Settings",
  [householdSettingsPage]: "Household",
  [roomsSettingsPage]: roomsTitle,
  [devicesSettingsPage]: "Devices",
  [maintenanceSettingsPage]: "Maintenance",
  [activitySettingsPage]: "Activity",
  [appsSettingsPage]: "Apps",
  [agentsSettingsPage]: agentsTitle,
  [canUseSettingsPage]: canUseTitle,
  [modelsSettingsPage]: modelsTitle,
  [clientsSettingsPage]: "Clients",
  [systemSettingsPage]: "System",
};

/** A page of Settings' title, which Back on the page over it names. */
export function settingsPageTitle(
  page: string,
  params: PageParams,
  apps: readonly AppInfo[],
) {
  if (page === appSettingsPage) {
    const app = apps.find((each) => each.id === params.id);
    return app ? appSettingsTitle(app.name) : "Settings";
  }
  return pageTitles[page] ?? "Settings";
}

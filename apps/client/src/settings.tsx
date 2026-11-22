import type { AppInfo } from "@meetsanctum/app-sdk";
import type { Me } from "@meetsanctum/auth-protocol";
import { PageBar, type LiveFeed, type PageParams } from "@meetsanctum/ui-sdk";
import { useEffect } from "react";

import { ActivityPage, activitySettingsPage } from "./activity/page";
import { AgentsPage, agentsSettingsPage } from "./agents/agents-page";
import { CanUsePage, canUseSettingsPage } from "./agents/can-use-page";
import { agentsTitle, canUseTitle } from "./agents/words";
import { AppPage } from "./app-settings";
import { BackButton, Section } from "./components";
import type { CoreStatus } from "./core-status";
import { dashboardBackground, type OnHome } from "./dashboards";
import { AddAppsSection, appSettingsPage, AppsSection } from "./settings-apps";
import { ClientsSection } from "./settings-clients";
import { DevicesSection } from "./settings-devices";
import { NeedsAttentionSection } from "./settings-attention";
import { HouseholdSection } from "./settings-household";
import {
  MaintenancePage,
  maintenanceSettingsPage,
} from "./settings-maintenance";
import { SettingsOverview } from "./settings-overview";
import { RoomsSection } from "./settings-rooms";
import { StatusPage, statusSettingsPage } from "./settings-status";
import type { PowerAction } from "./settings-status-power";
import type { SetupTarget } from "./setup-guide";
import { SystemSettings } from "./system-settings";
import type { SystemStatus } from "./system-status";
import type { Devices } from "./use-devices";

// Settings: a system app, the core's own UI, which the shell brings rather
// than a package. Its first page shows what needs attention, while anything
// does, Sanctum itself included, then a row for each area, which opens the
// area's page: the household with where the home is, the rooms and floors,
// the devices, Maintenance, what's due for the devices, which the
// dashboard's Batteries tile opens too, the activity log, which a device's
// detail opens too, the apps the home has installed, each with a page of its
// preferences and what it brings, which its own pages open too, with those
// it can add, the AI agents with what they can use, the clients, this
// device among them, and System: Status, with a page of how the machine
// Sanctum runs on is doing, the version, updates and the last restore. Each
// page leads with Back, named for the page under it. It is the same on every
// device, a shared one too. Opened from the dashboard's setup guide, it opens
// the step's page over its first and starts it once: Add room, Add devices,
// or the home's location.

const householdSettingsPage = "household";
const roomsSettingsPage = "rooms";
const devicesSettingsPage = "devices";
const appsSettingsPage = "apps";
const clientsSettingsPage = "clients";
const systemSettingsPage = "system";

/** The page each step of the setup guide opens and starts. */
export const setupPage: Record<SetupTarget, string> = {
  "add-room": roomsSettingsPage,
  "add-devices": devicesSettingsPage,
  household: householdSettingsPage,
};

const pageTitles: Record<string, string> = {
  main: "Settings",
  [householdSettingsPage]: "Household",
  [roomsSettingsPage]: "Rooms and floors",
  [devicesSettingsPage]: "Devices",
  [maintenanceSettingsPage]: "Maintenance",
  [activitySettingsPage]: "Activity",
  [appsSettingsPage]: "Apps",
  [agentsSettingsPage]: agentsTitle,
  [canUseSettingsPage]: canUseTitle,
  [clientsSettingsPage]: "Clients",
  [systemSettingsPage]: "System",
  [statusSettingsPage]: "Status",
};

/** A page of Settings' title, which Back on the page over it names. */
export function settingsPageTitle(
  page: string,
  params: PageParams,
  apps: readonly AppInfo[],
) {
  if (page === appSettingsPage) {
    const app = apps.find((each) => each.id === params.id);
    return app ? `${app.name} settings` : "Settings";
  }
  return pageTitles[page] ?? "Settings";
}

export const settingsApp = {
  id: "sanctum.settings",
  name: "Settings",
  icon: { glyph: "settings", color: "graphite" },
} as const;

export function SettingsPage(props: {
  // Settings' overview, an area's page, or a page it opens.
  page: string;
  params: PageParams;
  // Opens another of Settings' pages over this one.
  open: (page: string, params?: PageParams) => void;
  // Leaves a page Settings or an app opened for the one under it.
  back: () => void;
  // The title of the page of Settings under this one, which Back names;
  // without one, a page opened from elsewhere closes with Done.
  backTo?: string;
  apps: AppInfo[];
  // An app as the core answered after a change on its page, which the
  // shell takes at once for everything that shows it.
  onAppChanged?: (app: AppInfo) => void;
  // One was added here, as the core answered.
  onAppAdded?: (app: AppInfo) => void;
  // Home's background, which an app's previews stand on; mocha unless said.
  homeBackground?: string;
  me?: Me;
  core: CoreStatus;
  // The shell's live socket, which Devices and apps' preferences follow.
  live: LiveFeed;
  // The shell's devices and places, for what needs attention, Maintenance
  // and what the first page's rows say.
  devices: Pick<Devices, "devices" | "places">;
  // What is on Home, which a device's menu changes.
  home: OnHome;
  // Whether an update is running, for the connection veil's words.
  onUpdating: (updating: boolean) => void;
  onPowerAccepted?: (action: PowerAction) => void;
  // The host's status, which Home asks for now and then, for Needs
  // attention and System's rows; the Status page asks often itself.
  status?: SystemStatus;
  statusFailed?: boolean;
  // A step of the dashboard's setup guide to start on its page, until it
  // has started.
  start?: SetupTarget;
  onStarted?: () => void;
}) {
  const { start, onStarted, backTo } = props;
  useEffect(() => {
    if (start) onStarted?.();
  }, [start, onStarted]);
  const rooms = props.devices.places?.rooms ?? [];
  const back = backTo ? <BackButton to={backTo} onBack={props.back} /> : null;
  const openStatus = () => props.open(statusSettingsPage);
  const openCanUse = () => props.open(canUseSettingsPage);
  const openApp = (id: string) => props.open(appSettingsPage, { id });
  switch (props.page) {
    case activitySettingsPage:
      return (
        <ActivityPage
          device={props.params.device}
          apps={props.apps}
          live={props.live}
          onDone={props.back}
          backTo={backTo}
        />
      );
    case maintenanceSettingsPage:
      return (
        <MaintenancePage
          devices={props.devices.devices}
          rooms={rooms}
          apps={props.apps}
          onDone={props.back}
          backTo={backTo}
        />
      );
    case statusSettingsPage:
      return (
        <StatusPage
          apps={props.apps}
          onDone={props.back}
          backTo={backTo}
          onPowerAccepted={props.onPowerAccepted}
        />
      );
    case appSettingsPage: {
      const app = props.apps.find((each) => each.id === props.params.id);
      return app ? (
        <AppPage
          // Another version is another manifest: start again from nothing.
          key={`${app.id}@${app.version}`}
          app={app}
          apps={props.apps}
          devices={props.devices.devices}
          rooms={rooms}
          live={props.live}
          background={props.homeBackground ?? dashboardBackground.mocha}
          onChanged={props.onAppChanged ?? (() => undefined)}
          openStatus={openStatus}
          openCanUse={openCanUse}
          onDone={props.back}
          backTo={backTo}
        />
      ) : null;
    }
    case householdSettingsPage:
      return <HouseholdSection page={back} />;
    case roomsSettingsPage:
      return (
        <>
          <PageBar title="Rooms and floors" leading={back} />
          <RoomsSection live={props.live} adding={start === "add-room"} />
        </>
      );
    case devicesSettingsPage:
      return (
        <DevicesSection
          apps={props.apps}
          live={props.live}
          home={props.home}
          adding={start === "add-devices"}
          notSetUp={props.status?.notSetUp}
          page={back}
        />
      );
    case appsSettingsPage:
      return (
        <>
          <AppsSection apps={props.apps} onOpen={openApp} page={back} />
          <AddAppsSection
            apps={props.apps}
            onAdded={(app) => {
              props.onAppAdded?.(app);
              props.open(appSettingsPage, { id: app.id });
            }}
          />
        </>
      );
    case agentsSettingsPage:
      return (
        <AgentsPage
          apps={props.apps}
          live={props.live}
          onOpenCanUse={openCanUse}
          page={back}
        />
      );
    case canUseSettingsPage:
      return (
        <CanUsePage
          apps={props.apps}
          live={props.live}
          onOpenApp={openApp}
          onDone={props.back}
          backTo={backTo}
        />
      );
    case clientsSettingsPage:
      return <ClientsSection page={back} />;
    case systemSettingsPage:
      return (
        <Section id="settings-system" title="System" page={back}>
          <SystemSettings
            core={props.core}
            onUpdating={props.onUpdating}
            status={props.status}
            statusFailed={props.statusFailed ?? false}
            onOpenStatus={openStatus}
          />
        </Section>
      );
  }
  return (
    <>
      <PageBar title="Settings" />
      <NeedsAttentionSection
        devices={props.devices.devices}
        rooms={rooms}
        apps={props.apps}
        status={props.status}
        onOpenStatus={openStatus}
        onOpenApp={openApp}
      />
      <SettingsOverview
        apps={props.apps}
        devices={props.devices.devices}
        places={props.devices.places}
        live={props.live}
        me={props.me}
        status={props.status}
        statusFailed={props.statusFailed ?? false}
        open={props.open}
      />
    </>
  );
}

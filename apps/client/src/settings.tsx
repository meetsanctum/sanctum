import type { AppInfo } from "@meetsanctum/app-sdk";
import type { Me } from "@meetsanctum/auth-protocol";
import { PageBar, type LiveFeed, type PageParams } from "@meetsanctum/ui-sdk";
import { useEffect } from "react";

import {
  ActivityPage,
  ActivitySection,
  activitySettingsPage,
} from "./activity/page";
import { AppPage } from "./app-settings";
import { Row, Section } from "./components";
import type { CoreStatus } from "./core-status";
import { dashboardBackground, type OnHome } from "./dashboards";
import { appSettingsPage, AppsSection } from "./settings-apps";
import { ClientsSection } from "./settings-clients";
import { DevicesSection } from "./settings-devices";
import { NeedsAttentionSection } from "./settings-attention";
import { HouseholdSection } from "./settings-household";
import {
  MaintenancePage,
  MaintenanceSection,
  maintenanceSettingsPage,
} from "./settings-maintenance";
import { RoomsSection } from "./settings-rooms";
import { StatusPage, statusSettingsPage } from "./settings-status";
import type { PowerAction } from "./settings-status-power";
import type { SetupTarget } from "./setup-guide";
import { SystemSettings } from "./system-settings";
import type { SystemStatus } from "./system-status";
import type { Devices } from "./use-devices";

// Settings: a system app, the core's own UI, which the shell brings rather
// than a package. It shows what needs attention, first while anything does,
// Sanctum itself included, then Maintenance, what's due for the devices,
// with a page of it all, which the dashboard's Batteries tile opens too, the
// household with where the home is, the apps the home has installed, each
// with a page of its preferences and what it brings, which its own pages
// open too, the rooms, the devices, the activity log's newest entries with a
// page of it all, which a device's detail opens too, this device, the
// clients, and System: Status, with a page of how the machine Sanctum runs
// on is doing, the version, updates and the last restore. It is the same on
// every device, a shared one too. Opened from the dashboard's setup guide,
// it shows the step's section and starts it once: Add room, Add devices, or
// the home's location.

// The section each step of the setup guide starts in.
const sectionOf: Record<SetupTarget, string> = {
  "add-room": "settings-rooms",
  "add-devices": "settings-devices",
  household: "settings-household",
};

export const settingsApp = {
  id: "sanctum.settings",
  name: "Settings",
  icon: { glyph: "settings", color: "graphite" },
} as const;

export function SettingsPage(props: {
  // Settings' page, main or one app's, and its params.
  page: string;
  params: PageParams;
  // Opens another of Settings' pages over this one.
  open: (page: string, params?: PageParams) => void;
  // Leaves a page Settings or an app opened for the one under it.
  back: () => void;
  apps: AppInfo[];
  // An app as the core answered after a change on its page, which the
  // shell takes at once for everything that shows it.
  onAppChanged?: (app: AppInfo) => void;
  // Home's background, which an app's previews stand on; mocha unless said.
  homeBackground?: string;
  me?: Me;
  core: CoreStatus;
  // The shell's live socket, which Devices and apps' preferences follow.
  live: LiveFeed;
  // The shell's devices and places, for what needs attention and Maintenance.
  devices: Pick<Devices, "devices" | "places">;
  // What is on Home, which a device's menu changes.
  home: OnHome;
  // Whether an update is running, for the connection veil's words.
  onUpdating: (updating: boolean) => void;
  onPowerAccepted?: (action: PowerAction) => void;
  // The host's status, which Home asks for now and then, for Needs
  // attention and System's row; the Status page asks often itself.
  status?: SystemStatus;
  statusFailed?: boolean;
  // A step of the dashboard's setup guide to start, until it has started.
  start?: SetupTarget;
  onStarted?: () => void;
}) {
  const { me, start, onStarted } = props;
  useEffect(() => {
    if (!start) return;
    const section = document.getElementById(sectionOf[start]);
    if (!section) return;
    section.scrollIntoView();
    onStarted?.();
  }, [start, onStarted]);
  if (props.page === activitySettingsPage) {
    return (
      <ActivityPage
        device={props.params.device}
        apps={props.apps}
        live={props.live}
        onDone={props.back}
      />
    );
  }
  if (props.page === maintenanceSettingsPage) {
    return (
      <MaintenancePage
        devices={props.devices.devices}
        rooms={props.devices.places?.rooms ?? []}
        apps={props.apps}
        onDone={props.back}
      />
    );
  }
  if (props.page === statusSettingsPage) {
    return (
      <StatusPage
        apps={props.apps}
        onDone={props.back}
        onPowerAccepted={props.onPowerAccepted}
      />
    );
  }
  if (props.page === appSettingsPage) {
    const app = props.apps.find((each) => each.id === props.params.id);
    return app ? (
      <AppPage
        // Another version is another manifest: start again from nothing.
        key={`${app.id}@${app.version}`}
        app={app}
        apps={props.apps}
        devices={props.devices.devices}
        rooms={props.devices.places?.rooms ?? []}
        live={props.live}
        background={props.homeBackground ?? dashboardBackground.mocha}
        onChanged={props.onAppChanged ?? (() => undefined)}
        openStatus={() => props.open(statusSettingsPage)}
        onDone={props.back}
      />
    ) : null;
  }
  return (
    <>
      <PageBar title="Settings" />
      <NeedsAttentionSection
        devices={props.devices.devices}
        rooms={props.devices.places?.rooms ?? []}
        apps={props.apps}
        status={props.status}
        onOpenStatus={() => props.open(statusSettingsPage)}
        onOpenApp={(id) => props.open(appSettingsPage, { id })}
      />
      <MaintenanceSection
        devices={props.devices.devices}
        rooms={props.devices.places?.rooms ?? []}
        onShowAll={() => props.open(maintenanceSettingsPage)}
      />
      <HouseholdSection />
      <AppsSection
        apps={props.apps}
        onOpen={(id) => props.open(appSettingsPage, { id })}
      />
      <RoomsSection live={props.live} adding={start === "add-room"} />
      <DevicesSection
        apps={props.apps}
        live={props.live}
        home={props.home}
        adding={start === "add-devices"}
      />
      <ActivitySection
        apps={props.apps}
        live={props.live}
        onShowAll={() => props.open(activitySettingsPage)}
      />
      {me && (
        <Section id="settings-device" title="This device">
          <Row
            title={me.client.name}
            detail={
              me.person
                ? `${me.person.name}'s ${me.client.kind} device`
                : "Shared by the household"
            }
          />
        </Section>
      )}
      <ClientsSection />
      <Section id="settings-system" title="System">
        <SystemSettings
          core={props.core}
          onUpdating={props.onUpdating}
          status={props.status}
          statusFailed={props.statusFailed ?? false}
          onOpenStatus={() => props.open(statusSettingsPage)}
        />
      </Section>
    </>
  );
}

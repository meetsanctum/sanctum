import type { AppInfo } from "@meetsanctum/app-sdk";
import type { Me } from "@meetsanctum/auth-protocol";
import { PageBar, type LiveFeed, type PageParams } from "@meetsanctum/ui-sdk";
import { useEffect } from "react";

import { ActivityPage } from "./activity/page";
import { AgentsPage } from "./agents/agents-page";
import { CanUsePage } from "./agents/can-use-page";
import { AppPage } from "./app-settings";
import { ModelsPage } from "./models/models-page";
import { BackButton } from "./components";
import type { CoreStatus } from "./core-status";
import { dashboardBackground, type OnHome } from "./dashboards";
import { AddAppsSection, AppsSection } from "./settings-apps";
import { ClientsSection } from "./settings-clients";
import { DevicesSection } from "./settings-devices";
import { returnToGroup } from "./settings-device-groups";
import { NeedsAttentionSection } from "./settings-attention";
import { HouseholdSection } from "./settings-household";
import { PeoplePage } from "./people/people-page";
import { PersonPage } from "./people/person-page";
import { MaintenancePage } from "./settings-maintenance";
import { SettingsOverview } from "./settings-overview";
import { RoomsSection } from "./settings-rooms";
import { SystemPage } from "./settings-status";
import type { PowerAction } from "./settings-status-power";
import type { SetupTarget } from "./setup-guide";
import type { SystemStatus } from "./system-status";
import type { Devices } from "./use-devices";
import {
  activitySettingsPage,
  agentsSettingsPage,
  appSettingsPage,
  appsSettingsPage,
  canUseSettingsPage,
  clientsSettingsPage,
  deviceGroupSettingsPage,
  devicesSettingsPage,
  householdSettingsPage,
  maintenanceSettingsPage,
  modelsSettingsPage,
  peopleSettingsPage,
  personSettingsPage,
  roomsSettingsPage,
  roomsTitle,
  systemSettingsPage,
} from "./system-apps";

// Settings: a system app, the core's own UI, which the shell brings rather
// than a package. Its first page shows what needs attention, while anything
// does, Sanctum itself included, then a row for each area, which opens the
// area's page: the household with where the home is, its people, each with
// a page of their own, the rooms and floors,
// the devices, by category, each with a page of its own, Maintenance, what's
// due for the devices, which the
// dashboard's Batteries tile opens too, the activity log, which a device's
// detail opens too, the apps the home has installed, each with a page of its
// preferences and what it brings, which its own pages open too, with those
// it can add, the AI agents with what they can use, the AI models, the
// clients, this
// device among them, and System: how the machine Sanctum runs on is doing,
// the version, updates and the last restore. Each
// page leads with Back, named for the page under it. It is the same on every
// device, a shared one too. Opened from the dashboard's setup guide, it opens
// the step's page over its first and starts it once: Add room, Add devices,
// or the home's location.

export function SettingsPage(props: {
  // Settings' overview, an area's page, or a page it opens.
  page: string;
  params: PageParams;
  // Opens another of Settings' pages over this one.
  open: (page: string, params?: PageParams) => void;
  // Leaves a page Settings or an app opened for the one under it.
  back: () => void;
  // The title of the page under this one, which Back names;
  // without one, a page opened from elsewhere closes with Done.
  backTo?: string;
  apps: AppInfo[];
  // An app as the core answered after a change on its page, which the
  // shell takes at once for everything that shows it.
  onAppChanged?: (app: AppInfo) => void;
  // One was added here, as the core answered.
  onAppAdded?: (app: AppInfo) => void;
  // Opens an app as Apps does: its own page, or the shell's default one for
  // an app without one. AI models opens Ollama's, and an add opens the app.
  onOpenApp?: (appId: string) => void;
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
  // attention and System's row; the System page asks often itself.
  status?: SystemStatus;
  statusFailed?: boolean;
  // A step of the dashboard's setup guide to start on its page, until it
  // has started.
  start?: SetupTarget;
  onStarted?: () => void;
  onAddDevicesStarted?: () => void;
}) {
  const { start, onStarted, onAddDevicesStarted, backTo } = props;
  useEffect(() => {
    if (start) onStarted?.();
    onAddDevicesStarted?.();
  }, [start, onStarted, onAddDevicesStarted]);
  const rooms = props.devices.places?.rooms ?? [];
  const back = backTo ? <BackButton to={backTo} onBack={props.back} /> : null;
  const openStatus = () => props.open(systemSettingsPage);
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
    case systemSettingsPage:
      return (
        <SystemPage
          apps={props.apps}
          openAt={props.params}
          core={props.core}
          onUpdating={props.onUpdating}
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
    case peopleSettingsPage:
      return (
        <PeoplePage
          page={back}
          live={props.live}
          me={props.me}
          onOpen={(id, added) =>
            props.open(
              personSettingsPage,
              added ? { id, added: "yes" } : { id },
            )
          }
        />
      );
    case personSettingsPage:
      return props.params.id ? (
        <PersonPage
          key={props.params.id}
          live={props.live}
          personId={props.params.id}
          me={props.me}
          ask={props.params.added === "yes"}
          back={props.back}
          backTo={backTo}
        />
      ) : null;
    case roomsSettingsPage:
      return (
        <>
          <PageBar title={roomsTitle} leading={back} />
          <RoomsSection live={props.live} adding={start === "add-room"} />
        </>
      );
    case devicesSettingsPage:
      return (
        <DevicesSection
          key="groups"
          apps={props.apps}
          live={props.live}
          home={props.home}
          // The setup guide's step, or a page that opened Add devices.
          adding={start === "add-devices" || props.params.add === "true"}
          notSetUp={props.status?.notSetUp}
          page={back}
          known={props.devices.devices}
          knownRooms={props.devices.places?.rooms}
          onOpenGroup={(id) => props.open(deviceGroupSettingsPage, { id })}
        />
      );
    case deviceGroupSettingsPage: {
      const group = props.params.id;
      return (
        <DevicesSection
          key={group}
          apps={props.apps}
          live={props.live}
          home={props.home}
          notSetUp={props.status?.notSetUp}
          group={group}
          known={props.devices.devices}
          knownRooms={props.devices.places?.rooms}
          // Back puts focus on the category's row it came from.
          page={
            backTo ? (
              <BackButton
                to={backTo}
                onBack={() => {
                  if (group) returnToGroup(group);
                  props.back();
                }}
              />
            ) : null
          }
        />
      );
    }
    case appsSettingsPage:
      return (
        <>
          <AppsSection apps={props.apps} onOpen={openApp} page={back} />
          <AddAppsSection
            apps={props.apps}
            onAdded={(app) => {
              props.onAppAdded?.(app);
              // An added app opens as from Apps: its own page is where it
              // gets going, and its settings stay a step away there.
              if (props.onOpenApp) props.onOpenApp(app.id);
              else props.open(appSettingsPage, { id: app.id });
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
          onOpenApp={openApp}
          page={back}
        />
      );
    case modelsSettingsPage:
      return (
        <ModelsPage
          live={props.live}
          page={back}
          apps={props.apps}
          onAppAdded={props.onAppAdded}
          onOpenApp={props.onOpenApp}
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

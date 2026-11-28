import type { AppInfo, DashboardInfo } from "@meetsanctum/app-sdk";
import type { Me } from "@meetsanctum/auth-protocol";
import {
  Button,
  mainPage,
  Problem,
  type createLiveFeed,
  type PageParams,
  type Tile,
} from "@meetsanctum/ui-sdk";
import { Component, Suspense, useEffect, type ReactNode } from "react";

import { AppNotice, WhileNotRunning } from "./app-state";
import type { HostedApp, Route } from "./apps";
import { AppsPage, appsPage, type ListedApp } from "./apps-page";
import { DefaultAppPage } from "./default-app-page";
import type { CoreStatus } from "./core-status";
import { dashboardBackground, type OnHome } from "./dashboards";
import { EditHome } from "./edit-home";
import { AppFrame } from "./frames/app-frame";
import { HomeRooms } from "./home-dashboard";
import { useHomeDevices } from "./home-devices";
import { HomeWidgets, type ShownCard } from "./home-widgets";
import { lazyPage } from "./lazy-page";
import {
  CategoryPage,
  HomeStatus,
  noRoomPage,
  NoRoomPage,
  placePages,
  RoomPage,
} from "./place-pages";
import type { SectionEntities } from "./room-sections";
import type { useSettingsNavigation } from "./settings-navigation";
import { SetupGuide, SetupLeft } from "./setup-guide";
import {
  automationsApp,
  devicesSettingsPage,
  householdSettingsPage,
  maintenanceSettingsPage,
  settingsApp,
  systemSettingsPage,
} from "./system-apps";
import type { SystemStatus } from "./system-status";

// The system apps load the first time one opens, so Home has less to load
// and run, and in idle time once Home has its devices, so opening one need
// not wait for it. A load that fails ahead of time is left to the opening,
// whose boundary says so (SystemPageBoundary).
const { Page: SettingsPage, preload: preloadSettings } = lazyPage(() =>
  import("./settings").then((module) => module.SettingsPage),
);
const { Page: AutomationsPage, preload: preloadAutomations } = lazyPage(() =>
  import("./automations/page").then((module) => module.AutomationsPage),
);

/** Loads Settings and Automations ahead of time, two seconds after `ready`. */
export function usePreloadSystemPages(ready: boolean) {
  useEffect(() => {
    if (!ready) return;
    const later = setTimeout(() => {
      void preloadSettings().catch(() => undefined);
      void preloadAutomations().catch(() => undefined);
    }, 2_000);
    return () => clearTimeout(later);
  }, [ready]);
}

type HomePageProps = {
  route: Route | undefined;
  routeDepth: number;
  routeApp: HostedApp | undefined;
  isAppPage: boolean;
  isDefaultPage: boolean;
  openedByItsApp: boolean;
  back: () => void;
  opener: (app: string) => (page: string, params?: PageParams) => void;
  setRoutes: (routes: Route[] | ((current: Route[]) => Route[])) => void;
  settingsOf: (app: string) => () => void;
  settings: ReturnType<typeof useSettingsNavigation>;
  listed: ListedApp[];
  appsWaiting: boolean;
  installed: AppInfo[];
  pins: string[] | undefined;
  changePins: (next: string[]) => Promise<unknown>;
  appChanged: (app: AppInfo) => void;
  appAdded: (app: AppInfo) => void;
  live: ReturnType<typeof createLiveFeed>;
  ask: (app: string, permissions: readonly string[]) => Promise<boolean>;
  core: CoreStatus;
  shownStatus: SystemStatus | undefined;
  statusFailed: boolean;
  setUpdateRunning: (running: boolean) => void;
  me: Me | undefined;
  dashboard: DashboardInfo | undefined;
  dashboards: DashboardInfo[] | undefined;
  home: OnHome;
  isEditingHome: boolean;
  showDashboard: (id: string) => void;
  setEditingHome: (editing: boolean) => void;
  openDevice: (tile: Tile) => void;
  openRoomDevice: (tile: Tile) => void;
  openAppDevice: (tile: Tile) => void;
  sectionEntities: SectionEntities;
  widgetCards: ReadonlyMap<string, ShownCard>;
  hostUrl: string;
  deviceMode: "day" | "evening";
  isVeiled: boolean;
};

export function HomePage(props: HomePageProps) {
  const { route, routeDepth, dashboard, isEditingHome } = props;
  return (
    <Suspense fallback={null}>
      {routeDepth === 0 && dashboard && (
        <h1 className="sr-only">
          {isEditingHome ? `Edit ${dashboard.name}` : dashboard.name}
        </h1>
      )}
      {route?.app === appsPage ? (
        <AppsPage
          apps={props.listed}
          starting={props.appsWaiting && props.installed.length === 0}
          pins={props.pins}
          onPins={(next) => void props.changePins(next).catch(() => undefined)}
        />
      ) : (
        <HomePageWithDevices {...props} />
      )}
    </Suspense>
  );
}

function afterAddDevices(route: Route): Route {
  const { add: _, ...params } = route.params;
  return { ...route, params };
}

function HomePageWithDevices({
  route,
  routeDepth,
  routeApp,
  isAppPage,
  isDefaultPage,
  openedByItsApp,
  back,
  opener,
  setRoutes,
  settingsOf,
  settings,
  installed,
  appChanged,
  appAdded,
  live,
  ask,
  core,
  shownStatus,
  statusFailed,
  setUpdateRunning,
  me,
  dashboards,
  home,
  isEditingHome,
  showDashboard,
  setEditingHome,
  openDevice,
  openRoomDevice,
  openAppDevice,
  sectionEntities,
  widgetCards,
  hostUrl,
  deviceMode,
  isVeiled,
}: HomePageProps) {
  const devices = useHomeDevices();
  const onDashboard = routeDepth === 0;
  const addDevicesRequest =
    route?.app === settingsApp.id &&
    route.page === devicesSettingsPage &&
    route.params.add === "true"
      ? route
      : undefined;
  // Consuming the request keeps the Devices page and its dialog mounted.
  const shownRoute = addDevicesRequest
    ? afterAddDevices(addDevicesRequest)
    : route;
  const routeKey = `${routeDepth}:${JSON.stringify(shownRoute)}`;
  return (
    <>
      {route?.app === automationsApp.id ? (
        <SystemPageBoundary key={routeKey} name="Automations">
          <AutomationsPage
            page={route.page}
            params={route.params}
            open={opener(automationsApp.id)}
            back={back}
            apps={installed}
            devices={devices}
            live={live}
            openAppSettings={(app) => settingsOf(app)()}
            openStatus={() => opener(settingsApp.id)(systemSettingsPage)}
            ask={ask}
          />
        </SystemPageBoundary>
      ) : route?.app === settingsApp.id ? (
        <SystemPageBoundary key={routeKey} name="Settings">
          <SettingsPage
            onPowerAccepted={(going) => live.publish({ type: "system", going })}
            page={route.page}
            params={route.params}
            open={opener(settingsApp.id)}
            back={back}
            backTo={settings.backTo}
            apps={installed}
            onAppChanged={appChanged}
            onAppAdded={appAdded}
            onOpenApp={(appId) =>
              setRoutes((current) =>
                current.at(-1) === route
                  ? [{ app: appId, page: mainPage, params: {} }]
                  : current,
              )
            }
            homeBackground={
              dashboardBackground[
                dashboards?.find((each) => each.kind === "home")?.background ??
                  "mocha"
              ]
            }
            me={me}
            core={core}
            live={live}
            devices={devices}
            home={home}
            onUpdating={setUpdateRunning}
            status={shownStatus}
            statusFailed={statusFailed}
            start={settings.start}
            onStarted={settings.onStarted}
            onAddDevicesStarted={
              addDevicesRequest &&
              (() =>
                setRoutes((current) =>
                  current.at(-1) === addDevicesRequest
                    ? [
                        ...current.slice(0, -1),
                        afterAddDevices(addDevicesRequest),
                      ]
                    : current,
                ))
            }
          />
        </SystemPageBoundary>
      ) : route?.app === placePages ? (
        route.page === "room" ? (
          <RoomPage
            key={routeKey}
            roomId={route.params.id ?? ""}
            devices={devices}
            apps={installed}
            entities={sectionEntities}
            openDevice={openRoomDevice}
            back={back}
          />
        ) : route.page === noRoomPage ? (
          <NoRoomPage
            key={routeKey}
            devices={devices}
            openDevice={openRoomDevice}
            back={back}
          />
        ) : (
          <CategoryPage
            key={routeKey}
            id={route.params.id ?? ""}
            devices={devices}
            openDevice={openDevice}
            openRoom={(id) => opener(placePages)("room", { id })}
            back={back}
          />
        )
      ) : route && routeApp && isDefaultPage ? (
        <DefaultAppPage
          key={`${routeApp.info.id}@${routeApp.info.version}:${routeApp.info.build ?? ""}`}
          app={routeApp.info}
          live={live}
          deviceCount={
            devices.devices.filter(
              (device) => device.driver === routeApp.info.id,
            ).length
          }
          openDevices={() => opener(settingsApp.id)(devicesSettingsPage)}
          openSettings={settingsOf(route.app)}
          openStatus={() => opener(settingsApp.id)(systemSettingsPage)}
        />
      ) : route && routeApp && isAppPage ? (
        <>
          {/* Its top bar keeps the page's way out, and the gear. */}
          <AppNotice
            app={routeApp.info}
            permissionsAre="settings"
            deviceCount={
              devices.devices.filter(
                (device) => device.driver === routeApp.info.id,
              ).length
            }
            openSettings={openedByItsApp ? undefined : settingsOf(route.app)}
            openStatus={() => opener(settingsApp.id)(systemSettingsPage)}
          />
          <WhileNotRunning
            app={routeApp.info}
            // The page's sections, as they stand in it.
            className="flex shrink-0 grow flex-col gap-6"
          >
            <AppFrame
              // Afresh when the home moves to another address.
              key={`${route.app} ${hostUrl}`}
              app={routeApp}
              page={route.page}
              params={route.params}
              shown={routeKey}
              open={opener(route.app)}
              back={back}
              openSettings={settingsOf(route.app)}
              openHousehold={(title) =>
                opener(settingsApp.id)(
                  householdSettingsPage,
                  title ? { from: title } : {},
                )
              }
              openDevice={(id) => {
                // A device's detail opens on its first tile, as from a room.
                const tile = devices.tiles.find((each) => each.deviceId === id);
                if (tile) openAppDevice(tile);
              }}
              addDevices={(returnParams, title) =>
                setRoutes((current) => {
                  if (current.at(-1) !== route) return current;
                  const origin = returnParams
                    ? { ...route, params: { ...route.params, ...returnParams } }
                    : route;
                  return [
                    ...current.slice(0, -1),
                    origin,
                    {
                      app: settingsApp.id,
                      page: devicesSettingsPage,
                      // Back names the page it returns to.
                      params: {
                        add: "true",
                        ...(title ? { from: title } : {}),
                      },
                    },
                  ];
                })
              }
              mode={deviceMode}
              household={devices.places?.home}
              isAway={isVeiled}
            />
          </WhileNotRunning>
        </>
      ) : isEditingHome ? (
        <EditHome devices={devices} home={home} />
      ) : (
        onDashboard &&
        // Until the devices have loaded, the dashboard shows what
        // it has; the guide only once the home is known to have none.
        (devices.loaded && devices.devices.length === 0 ? (
          <SetupGuide
            devices={devices}
            live={live}
            person={me?.person?.name ?? null}
            open={settings.openSetup}
          />
        ) : (
          <>
            {devices.loaded && (
              <SetupLeft
                devices={devices}
                live={live}
                open={settings.openSetup}
              />
            )}
            <HomeStatus
              devices={devices}
              problems={shownStatus?.problems ?? []}
              notSetUp={shownStatus?.notSetUp}
              apps={installed}
              openAttention={settings.openOverview}
              openStatus={() => opener(settingsApp.id)(systemSettingsPage)}
              openMaintenance={() =>
                opener(settingsApp.id)(maintenanceSettingsPage)
              }
              openCategory={(id) =>
                setRoutes([
                  {
                    app: placePages,
                    page: "category",
                    params: { id },
                  },
                ])
              }
            />
            <HomeRooms
              devices={devices}
              onHome={home.devices}
              homeName={home.name}
              apps={installed}
              entities={sectionEntities}
              openRoom={(id) =>
                setRoutes([
                  {
                    app: placePages,
                    page: "room",
                    params: { id },
                  },
                ])
              }
              openNoRoom={() =>
                setRoutes([
                  {
                    app: placePages,
                    page: noRoomPage,
                    params: {},
                  },
                ])
              }
              openDevice={openDevice}
              onEdit={() => {
                const homeDashboard = dashboards?.find(
                  (each) => each.kind === "home",
                );
                if (homeDashboard) showDashboard(homeDashboard.id);
                setEditingHome(true);
              }}
            />
            <HomeWidgets
              apps={installed}
              cards={widgetCards}
              open={(app, page) => opener(app)(page)}
            />
          </>
        ))
      )}
    </>
  );
}

// Keep the shell available if a system page still fails after a reload.
class SystemPageBoundary extends Component<
  { name: string; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex flex-col items-start gap-2">
        <Problem title={`${this.props.name} didn't open`}>
          Something went wrong while showing it. Reload to try again.
        </Problem>
        <Button variant="outline" onClick={() => location.reload()}>
          Reload
        </Button>
      </div>
    );
  }
}

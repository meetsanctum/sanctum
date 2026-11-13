import type { AppInfo, TemperatureUnit } from "@meetsanctum/app-sdk";
import type { Me } from "@meetsanctum/auth-protocol";
import {
  AppScope,
  createLiveFeed,
  HomeTimeZoneProvider,
  PageBarSlot,
  TemperatureUnitProvider,
  type CoreBridge,
  type PageParams,
  type Tile,
} from "@meetsanctum/ui-sdk";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { plainIcon } from "./app-settings";
import { AppNotice, WhileNotRunning } from "./app-state";
import { usePermissionSheet } from "./permission-sheet";
import {
  AppHosts,
  hasPage,
  hostedApps,
  opens,
  pageOf,
  type Route,
} from "./apps";
import { AppsPage, appsPage, type ListedApp } from "./apps-page";
import { followHost, forgetHost, moveHost } from "./auth/session";
import { AutomationsPage, automationsApp } from "./automations/page";
import { usePrefersDark } from "./color-scheme";
import { ConnectionVeil, type ConnectionState } from "./connection-veil";
import { useGoing } from "./power-notice";
import { coreJson } from "./core-fetch";
import { startCoreStatusPolling, type CoreStatus } from "./core-status";
import { activitySettingsPage } from "./activity/page";
import { DeviceDetail } from "./device-detail";
import {
  dashboardBackground,
  dashboardFrame,
  useCurrentDashboard,
  useDashboards,
} from "./dashboards";
import { connectLive } from "./live";
import { EditHome } from "./edit-home";
import { HomeRooms } from "./home-dashboard";
import { HomeSidebar } from "./home-sidebar";
import { HomeWidgets, useWidgetCards } from "./home-widgets";
import { PageDoesntMatch } from "./page-mismatch";
import { CategoryPage, HomeStatus, placePages, RoomPage } from "./place-pages";
import { usePins } from "./pins";
import { useSectionEntities } from "./room-sections";
import { SettingsPage, settingsApp } from "./settings";
import { maintenanceSettingsPage } from "./settings-maintenance";
import { statusSettingsPage } from "./settings-status";
import { appSettingsPage } from "./settings-apps";
import { SetupGuide, SetupLeft, type SetupTarget } from "./setup-guide";
import { getShell, type FoundHost, type StoredHost } from "./shell";
import { ShellFrame } from "./shell-frame";
import { useSidebarLayout } from "./sidebar-state";
import { useSystemStatus } from "./system-status";
import { TopBar } from "./top-bar";
import { useDevices } from "./use-devices";

function useCoreStatus() {
  const [status, setStatus] = useState<CoreStatus>({ state: "checking" });
  const polling = useRef<ReturnType<typeof startCoreStatusPolling>>(undefined);
  useEffect(() => {
    // The same answer again changes nothing on screen.
    const started = startCoreStatusPolling((next) =>
      setStatus((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      ),
    );
    polling.current = started;
    return started.stop;
  }, []);
  const checkNow = useCallback(() => polling.current?.checkNow(), []);
  return { status, checkNow };
}

// The signed-in screen: the sidebar, docked beside the page or floating over
// it (shell-frame.tsx), and the page with its top bar: the dashboard this
// client shows, a room's or a category's page on that dashboard's background
// with no card around it, or an app's page in the device's mode. Home shows
// the home's status, each room with what is on Home (home-dashboard.tsx),
// then installed apps' widgets, and Edit Home from its menu; the other
// dashboards show the same. While the home has no devices it shows how to
// set the home up instead, and then the steps still left above the rooms
// (setup-guide.tsx). The sidebar starts with the household's pinned apps and
// Apps, which lists Settings, Automations and the apps that have a page of
// their own, then lists the dashboards, the categories and the rooms
// (home-sidebar.tsx). Room pages draw apps' room sections from their
// entities (place-pages.tsx). An app's page opens its preferences,
// Settings → Apps → the app. There is no Back: the sidebar
// leads everywhere, and a page that another opened, such as an editor, has
// its own way out, which returns to the page under it. Until the screen
// has first connected to the stored host, and whenever the core is away after
// that, such as when an update restarts it, the connection veil covers the
// screen and it reconnects by itself; it offers a way out once the home has
// not answered for a while.
export function Home(props: {
  host: StoredHost;
  onHostMoved: (host: StoredHost) => void;
  onSignedOut: () => void;
  // The host, or the same home on another host, answered with another CA:
  // nothing more is asked of it until it is checked again.
  onCertificateChanged: (
    host: StoredHost,
    url: string,
    found?: FoundHost,
  ) => void;
}) {
  const { host, onHostMoved, onCertificateChanged } = props;
  const { status: core, checkNow } = useCoreStatus();
  const [updateRunning, setUpdateRunning] = useState(false);
  const liveConnection = useRef<ReturnType<typeof connectLive>>(undefined);
  const [found, setFound] = useState(false);
  const [certificateNotValid, setCertificateNotValid] = useState(false);
  const [reachedCore, setReachedCore] = useState(false);
  const [me, setMe] = useState<Me>();
  const [installed, setInstalled] = useState<AppInfo[]>([]);
  const [routes, setRoutes] = useState<Route[]>([]);
  // A device's detail covers the screen, inside it.
  const [screen, setScreen] = useState<HTMLDivElement | null>(null);
  const sidebarTrigger = useRef<HTMLButtonElement>(null);
  const live = useMemo(() => createLiveFeed(), []);
  const refreshId = useRef(0);
  const changedApps = useRef(new Map<string, AppInfo>());
  const { dashboards, rename, home } = useDashboards(live);
  const { pins, change: changePins } = usePins(live);
  const { current: dashboard, show: showDashboard } =
    useCurrentDashboard(dashboards);
  // Edit Home, until Done, or until the page or dashboard on show changes.
  const [editingHome, setEditingHome] = useState(false);
  const devices = useDevices(live);
  // A restart or shutdown someone asked for, which the veil says.
  const going = useGoing(live, core.state);
  // How the machine Sanctum runs on is doing, for the dashboard's Attention
  // tile, Needs attention and System's row; its page asks often itself.
  const { status: systemStatus, failed: statusFailed } = useSystemStatus({
    enabled: found && core.state === "online",
    everyMs: 60_000,
  });
  // A failed answer keeps no old reading on show: System's row says it can't
  // check, and nothing leads Needs attention or the tile on a stale one.
  const shownStatus = statusFailed ? undefined : systemStatus;
  // The device whose detail is open, kept while it closes.
  const [detail, setDetail] = useState<{ key: string | null; open: boolean }>({
    key: null,
    open: false,
  });
  const openDevice = useCallback(
    (tile: Tile) => setDetail({ key: tile.key, open: true }),
    [],
  );
  const closeDevice = useCallback(
    () => setDetail((current) => ({ ...current, open: false })),
    [],
  );
  const sectionEntities = useSectionEntities(live, installed, devices.fail);
  const widgetCards = useWidgetCards(live, installed);

  useEffect(() => {
    // The platform lets the macOS window's material through the frame and
    // says what moves the window (src/styles.css), here and in what is
    // portalled out of the screen.
    document.documentElement.dataset.platform = getShell().platform;
    return () => {
      delete document.documentElement.dataset.mode;
      delete document.documentElement.dataset.platform;
    };
  }, []);
  const prefersDark = usePrefersDark();
  // The page in the top bar's slot, for an app page's title and buttons.
  const [pageSlot, setPageSlot] = useState<HTMLDivElement | null>(null);

  // The host answers at its stored address, or discovery finds it by id at a
  // new one, which is stored before anything is asked there.
  useEffect(
    () =>
      followHost(
        host,
        (url) => {
          setCertificateNotValid(false);
          if (url === host.url) {
            setFound(true);
          } else {
            return moveHost(host, url).then((moved) => {
              // A move skipped while this host is being forgotten is tried
              // again later, not taken as done.
              if (!moved) throw new Error("The host move was skipped");
              onHostMoved(moved);
            });
          }
        },
        (url, failure, foundThere) => {
          if (failure === "changed") {
            onCertificateChanged(host, url, foundThere);
          } else {
            setCertificateNotValid(true);
          }
        },
      ),
    [host, onHostMoved, onCertificateChanged],
  );

  const refresh = useCallback(async () => {
    const requestId = ++refreshId.current;
    changedApps.current.clear();
    const [nextMe, nextApps] = await Promise.allSettled([
      coreJson<Me>("/api/auth/me"),
      coreJson<AppInfo[]>("/api/apps"),
    ]);
    if (requestId !== refreshId.current) return;
    if (nextMe.status === "fulfilled") setMe(nextMe.value);
    // The same list keeps the apps' clients, so their pages do not reload.
    if (nextApps.status === "fulfilled") {
      // Keep grant changes received during this read without dropping the
      // rest of the list, including when it is the first read.
      const next = nextApps.value.map(
        (app) => changedApps.current.get(app.id) ?? app,
      );
      setInstalled((current) =>
        JSON.stringify(current) === JSON.stringify(next) ? current : next,
      );
    }
  }, []);

  useEffect(() => {
    if (!found) {
      return;
    }
    const update = () => {
      void refresh().catch(() => undefined);
      live.refresh();
    };
    update();
    // The live connection doesn't carry every change, so everything is
    // fetched again now and then, and when the window comes back.
    const timer = window.setInterval(update, 30_000);
    window.addEventListener("focus", update);
    // The apps read again whenever the connection comes back, and follow
    // its updates in between. Revoking this client elsewhere closes it at
    // once; any other close asks whether the core is still there.
    const connection = connectLive((state) => {
      if (state === "live") update();
      if (state === "offline") checkNow();
    }, live.publish);
    liveConnection.current = connection;
    return () => {
      refreshId.current += 1;
      window.clearInterval(timer);
      window.removeEventListener("focus", update);
      connection.stop();
      liveConnection.current = undefined;
    };
  }, [found, refresh, live, host.url, host.token, checkNow]);

  // Back after a restart or an outage: reconnect at once and read
  // everything again, rather than wait for the next try.
  const isAway = core.state === "offline" || core.state === "updating";
  const wasAway = useRef(false);
  useEffect(() => {
    if (isAway) {
      wasAway.current = true;
    } else if (core.state === "online" && wasAway.current && found) {
      wasAway.current = false;
      liveConnection.current?.retryNow();
      void refresh().catch(() => undefined);
      live.refresh();
    }
  }, [isAway, core.state, found, refresh, live]);

  // The core is reached once the host answered as itself and its core is up,
  // or as soon as it reports an update: until that commits it answers only
  // its health check, not the host's identity check. A rollback's restart is
  // then away, with the longer delay, not connecting.
  useEffect(() => {
    if (core.state === "updating" || (found && core.state === "online")) {
      setReachedCore(true);
    }
  }, [found, core.state]);

  // An app as the core answered a change of its permissions, which the
  // shell takes at once for everything that shows it.
  const appChanged = useCallback((changed: AppInfo) => {
    // A read started before this answer must keep these newer grants.
    changedApps.current.set(changed.id, changed);
    setInstalled((current) =>
      current.map((each) => (each.id === changed.id ? changed : each)),
    );
  }, []);
  // A change made on another client reaches this one at once, so the
  // app's pages get a client with what it holds now.
  useEffect(
    () =>
      live.subscribe({
        message(message) {
          if (message.type === "app") appChanged(message.app);
        },
      }),
    [live, appChanged],
  );
  const permissionSheet = usePermissionSheet(installed, appChanged);
  const { ask } = permissionSheet;
  const bridge = useMemo<CoreBridge>(
    () => ({ json: coreJson, live, ask }),
    [live, ask],
  );
  const apps = useMemo(
    () => hostedApps(installed, bridge),
    [installed, bridge],
  );

  // An app or page removed by a refresh must not leave an empty page, or a
  // dead one under it for its way out to return to, nor its page in
  // Settings.
  useEffect(() => {
    setRoutes((current) => {
      const remaining = current.filter((route) =>
        route.app === settingsApp.id
          ? route.page !== appSettingsPage ||
            installed.some((app) => app.id === route.params.id)
          : route.app === placePages ||
            route.app === appsPage ||
            route.app === automationsApp.id ||
            apps.some(
              (app) => app.info.id === route.app && hasPage(app, route.page),
            ),
      );
      return remaining.length === current.length ? current : remaining;
    });
  }, [apps, installed, routes]);

  const signOut = async () => {
    await coreJson("/api/auth/clients/revoke", {
      method: "POST",
      json: { id: host.clientId },
    }).catch(() => undefined);
    await forgetHost(host);
    props.onSignedOut();
  };

  // A page another opened leaves for the one under it.
  const back = useCallback(
    () => setRoutes((current) => current.slice(0, -1)),
    [],
  );
  const opener =
    (app: string) =>
    (page: string, params: PageParams = {}) =>
      setRoutes((current) => [...current, { app, page, params }]);
  // An app's preferences, over the page that opened them.
  const settingsOf = (app: string) => () =>
    opener(settingsApp.id)(appSettingsPage, { id: app });

  const route = routes.at(-1);
  const routeApp = route && apps.find((app) => app.info.id === route.app);
  const Page = route && pageOf(routeApp, route.page);
  const mismatch =
    route && hasPage(routeApp, route.page) ? routeApp?.mismatch : undefined;
  // A page another of its app's pages opened, such as an editor, has its
  // own way out, and opening settings over it would lose what it holds.
  const openedByItsApp = routes.length > 1 && routes.at(-2)?.app === route?.app;
  const onDashboard = routes.length === 0;
  const isEditingHome =
    editingHome && onDashboard && dashboard?.kind === "home";
  useEffect(() => {
    if (!onDashboard || dashboard?.kind !== "home") setEditingHome(false);
  }, [onDashboard, dashboard?.kind]);
  // A step of the setup guide Settings is to start, once: coming back to
  // Settings later starts nothing.
  const [setupStep, setSetupStep] = useState<SetupTarget>();
  const setupStarted = useCallback(() => setSetupStep(undefined), []);
  const openSettings = () => {
    setSetupStep(undefined);
    setRoutes([{ app: settingsApp.id, page: "main", params: {} }]);
  };
  const openSetup = (step: SetupTarget) => {
    setSetupStep(step);
    setRoutes([{ app: settingsApp.id, page: "main", params: {} }]);
  };
  const openAutomations = () =>
    setRoutes([{ app: automationsApp.id, page: "main", params: {} }]);
  // Somewhere new from the sidebar, which takes the floating one away.
  const go = (next: Route[]) => {
    setRoutes(next);
    sidebar.close();
  };

  // Settings, Automations and the apps with a page of their own, by name:
  // what Apps lists, and what may be pinned. An app without an icon of its
  // own shows the plain one, as in Settings.
  const listed: ListedApp[] = [
    { ...settingsApp, onOpen: openSettings },
    { ...automationsApp, onOpen: openAutomations },
    ...apps.filter(opens).map(({ info }) => ({
      id: info.id,
      name: info.name,
      icon: info.icon ?? plainIcon,
      onOpen: () => setRoutes([{ app: info.id, page: "main", params: {} }]),
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  // A dashboard and a room's or category's page are in Evening over the
  // dashboard's background, along with the menus portalled out of them; an
  // app's page, Apps included, fills its panel in the device's mode.
  const appPage = route !== undefined && route.app !== placePages;
  const deviceMode = prefersDark ? "evening" : "day";
  const mode = appPage ? deviceMode : "evening";
  useEffect(() => {
    document.documentElement.dataset.mode = mode;
  }, [mode]);

  // A core that answers only its health check is finishing an update, even
  // before the host has answered as itself. A host that has answered is found,
  // not unanswered, while its core comes up.
  const veil: ConnectionState | undefined = going
    ? going.action === "restart"
      ? "restarting"
      : going.away
        ? "off"
        : "shuttingDown"
    : core.state === "updating" || (isAway && updateRunning)
      ? "updating"
      : !reachedCore
        ? found
          ? "found"
          : "connecting"
        : isAway
          ? "away"
          : !found
            ? "connecting"
            : undefined;

  // What floats over the page closes under the veil.
  const isVeiled = veil !== undefined;
  const sidebar = useSidebarLayout(isVeiled);
  useEffect(() => {
    if (isVeiled) closeDevice();
  }, [isVeiled, closeDevice]);

  return (
    // How the household reads things, for the shell's pages and apps' alike.
    <Household home={devices.places?.home}>
      <AppHosts apps={apps}>
        <ShellFrame
          screenRef={setScreen}
          layout={sidebar}
          isPlace={!appPage}
          place={dashboard && dashboardFrame[dashboard.background]}
          deviceMode={deviceMode}
          panelBackground={
            appPage
              ? "var(--background)"
              : dashboard && dashboardBackground[dashboard.background]
          }
          isVeiled={isVeiled}
          triggerRef={sidebarTrigger}
          sidebar={(isFloating) => (
            <HomeSidebar
              isFloating={isFloating}
              isVeiled={isVeiled}
              layout={sidebar}
              routes={routes}
              listed={listed}
              pins={pins}
              dashboards={dashboards}
              shown={dashboard}
              showDashboard={showDashboard}
              go={go}
              devices={devices}
              account={
                me?.person
                  ? {
                      person: me.person,
                      onSettings: openSettings,
                      onSignOut: signOut,
                    }
                  : undefined
              }
            />
          )}
          panel={
            <>
              {/* Nothing on the page can be used under the veil. */}
              <div className="contents" inert={isVeiled}>
                <TopBar
                  sidebarTrigger={sidebarTrigger}
                  sidebarShown={sidebar.docked || sidebar.floating !== null}
                  sidebarDocked={sidebar.docked}
                  onSidebar={sidebar.toggle}
                  dashboard={onDashboard ? dashboard : undefined}
                  isVeiled={isVeiled}
                  onRename={rename}
                  onEditHome={{
                    disabled: !devices.loaded || devices.devices.length === 0,
                    open: () => setEditingHome(true),
                  }}
                  editingHome={
                    isEditingHome
                      ? { onDone: () => setEditingHome(false) }
                      : undefined
                  }
                  pageSlot={setPageSlot}
                  appSettings={
                    route && routeApp && (Page || mismatch) && !openedByItsApp
                      ? {
                          name: routeApp.info.name,
                          open: settingsOf(route.app),
                        }
                      : undefined
                  }
                />
                <PageBarSlot.Provider value={pageSlot}>
                  <main className={`page${appPage ? " app-page" : ""}`}>
                    {onDashboard && dashboard && (
                      <h1 className="sr-only">
                        {isEditingHome
                          ? `Edit ${dashboard.name}`
                          : dashboard.name}
                      </h1>
                    )}
                    {route?.app === appsPage ? (
                      <AppsPage
                        apps={listed}
                        pins={pins}
                        onPins={(next) =>
                          void changePins(next).catch(() => undefined)
                        }
                      />
                    ) : route?.app === automationsApp.id ? (
                      <AutomationsPage
                        key={`${routes.length}:${JSON.stringify(route)}`}
                        page={route.page}
                        params={route.params}
                        open={opener(automationsApp.id)}
                        back={back}
                        apps={installed}
                        devices={devices}
                        live={live}
                        openAppSettings={(app) => settingsOf(app)()}
                        openStatus={() =>
                          opener(settingsApp.id)(statusSettingsPage)
                        }
                        ask={ask}
                      />
                    ) : route?.app === settingsApp.id ? (
                      <SettingsPage
                        onPowerAccepted={(going) =>
                          live.publish({ type: "system", going })
                        }
                        key={`${routes.length}:${JSON.stringify(route)}`}
                        page={route.page}
                        params={route.params}
                        open={opener(settingsApp.id)}
                        back={back}
                        apps={installed}
                        onAppChanged={appChanged}
                        homeBackground={
                          dashboardBackground[
                            dashboards?.find((each) => each.kind === "home")
                              ?.background ?? "mocha"
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
                        start={route.page === "main" ? setupStep : undefined}
                        onStarted={setupStarted}
                      />
                    ) : route?.app === placePages ? (
                      route.page === "room" ? (
                        <RoomPage
                          key={`${routes.length}:${JSON.stringify(route)}`}
                          roomId={route.params.id ?? ""}
                          devices={devices}
                          apps={installed}
                          entities={sectionEntities}
                          openApp={(app, page, params) =>
                            opener(app)(page, params)
                          }
                          canOpen={(app, page) =>
                            hasPage(
                              apps.find((each) => each.info.id === app),
                              page,
                            )
                          }
                          openDevice={openDevice}
                          back={back}
                        />
                      ) : (
                        <CategoryPage
                          key={`${routes.length}:${JSON.stringify(route)}`}
                          id={route.params.id ?? ""}
                          devices={devices}
                          openDevice={openDevice}
                          openRoom={(id) => opener(placePages)("room", { id })}
                          back={back}
                        />
                      )
                    ) : routeApp && mismatch ? (
                      <PageDoesntMatch
                        app={routeApp.info}
                        mismatch={mismatch}
                      />
                    ) : route && routeApp && Page ? (
                      <AppScope client={routeApp.client}>
                        {/* Its top bar keeps the page's way out, and the gear. */}
                        <AppNotice
                          app={routeApp.info}
                          permissionsAre="settings"
                          deviceCount={
                            devices.devices.filter(
                              (device) => device.driver === routeApp.info.id,
                            ).length
                          }
                          openSettings={
                            openedByItsApp ? undefined : settingsOf(route.app)
                          }
                          openStatus={() =>
                            opener(settingsApp.id)(statusSettingsPage)
                          }
                        />
                        <WhileNotRunning
                          app={routeApp.info}
                          // The page's sections, as they stand in it.
                          className="flex shrink-0 grow flex-col gap-6"
                        >
                          <Page
                            // A page opened afresh starts afresh.
                            key={`${routes.length}:${JSON.stringify(route)}`}
                            params={route.params}
                            open={opener(route.app)}
                            back={back}
                            openSettings={settingsOf(route.app)}
                          />
                        </WhileNotRunning>
                      </AppScope>
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
                          open={openSetup}
                        />
                      ) : (
                        <>
                          {devices.loaded && (
                            <SetupLeft
                              devices={devices}
                              live={live}
                              open={openSetup}
                            />
                          )}
                          <HomeStatus
                            devices={devices}
                            problems={shownStatus?.problems ?? []}
                            apps={installed}
                            openAttention={openSettings}
                            openStatus={() =>
                              opener(settingsApp.id)(statusSettingsPage)
                            }
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
                            openDevice={openDevice}
                            onEdit={() => {
                              const homeDashboard = dashboards?.find(
                                (each) => each.kind === "home",
                              );
                              if (homeDashboard)
                                showDashboard(homeDashboard.id);
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
                  </main>
                </PageBarSlot.Provider>
              </div>
              {/* Over the page, under the top bar; it takes the page's
                  background, so it sits beside the page, not in it. */}
              <div aria-hidden="true" className="top-fade" />
            </>
          }
        >
          {veil && (
            <ConnectionVeil
              state={veil}
              host={host}
              certificateNotValid={certificateNotValid}
              onForgotten={props.onSignedOut}
            />
          )}
          <DeviceDetail
            container={screen}
            tileKey={detail.key}
            open={detail.open}
            devices={devices}
            apps={apps}
            live={live}
            home={home}
            onClose={closeDevice}
            onCovering={sidebar.setCovered}
            onShowActivity={(device) => {
              closeDevice();
              opener(settingsApp.id)(activitySettingsPage, { device });
            }}
            onOpenAppSettings={(app) => {
              closeDevice();
              settingsOf(app)();
            }}
            onOpenStatus={() => {
              closeDevice();
              opener(settingsApp.id)(statusSettingsPage);
            }}
          />
          {permissionSheet.sheet}
        </ShellFrame>
      </AppHosts>
    </Household>
  );
}

// The unit the household shows temperatures in, and the home's time zone,
// in which widgets' cards write times.
function Household(props: {
  home:
    { temperatureUnit: TemperatureUnit; timeZone: string | null } | undefined;
  children: ReactNode;
}) {
  return (
    <TemperatureUnitProvider unit={props.home?.temperatureUnit}>
      <HomeTimeZoneProvider timeZone={props.home?.timeZone}>
        {props.children}
      </HomeTimeZoneProvider>
    </TemperatureUnitProvider>
  );
}

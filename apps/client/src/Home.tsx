import type { TemperatureUnit } from "@meetsanctum/app-sdk";
import type { HourCycle } from "@meetsanctum/app-sdk/clock";
import type { Me } from "@meetsanctum/auth-protocol";
import {
  createLiveFeed,
  HomeTimeZoneProvider,
  mainPage,
  PageBarSlot,
  TemperatureUnitProvider,
  type CoreBridge,
  type PageParams,
} from "@meetsanctum/ui-sdk";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { usePermissionSheet } from "./permission-sheet";
import { hasDefaultPage, hostedApps, showsPage, type Route } from "./apps";
import { appsPage, listedApps } from "./apps-page";
import { appBackdrop } from "./default-app-page";
import { useDrawing } from "./drawing";
import { useInstalledApps } from "./installed-apps";
import { followHost, forgetHost, moveHost } from "./auth/session";
import { usePrefersDark } from "./color-scheme";
import { ConnectionVeil, type ConnectionState } from "./connection-veil";
import { useGoing } from "./power-notice";
import { coreJson } from "./core-fetch";
import { startCoreStatusPolling, type CoreStatus } from "./core-status";
import {
  dashboardBackground,
  dashboardFrame,
  useCurrentDashboard,
  useDashboards,
} from "./dashboards";
import { connectLive } from "./live";
import { HomePage, usePreloadSystemPages } from "./home-page";
import { HomeDevicesProvider, useDevicesSummary } from "./home-devices";
import { HomeSidebar } from "./home-sidebar";
import { useWidgetCards } from "./home-widgets";
import { OpenDeviceDetail, useOpenDevice } from "./open-device";
import { OverlayHostProvider } from "./overlay-host";
import { placePages } from "./place-pages";
import { usePins } from "./pins";
import { useSectionEntities } from "./room-sections";
import {
  isSettingsRouteAvailable,
  useSettingsNavigation,
} from "./settings-navigation";
import { StickOffer } from "./stick-offer";
import { getShell, type FoundHost, type StoredHost } from "./shell";
import { ShellFrame } from "./shell-frame";
import { useSidebarLayout } from "./sidebar-state";
import { useSystemStatus } from "./system-status";
import { TopBar } from "./top-bar";
import { isShown, onShown } from "./while-shown";
import {
  activitySettingsPage,
  appSettingsPage,
  automationsApp,
  settingsApp,
  statusSettingsPage,
} from "./system-apps";

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
// Apps, which lists Settings, Automations and every installed app, then
// lists the dashboards, the categories and the rooms
// (home-sidebar.tsx). Room pages draw apps' room sections from their
// entities (place-pages.tsx). An app's page opens its preferences,
// Settings → Apps → the app. The sidebar leads between apps and places.
// A page opened from another has its own way back. Until the screen
// has first connected to the stored host, and whenever the core is away after
// that, such as when an update restarts it, the connection veil covers the
// screen and it reconnects by itself; it offers a way out once the home has
// not answered for a while. The home's devices are held around the screen
// (home-devices.tsx), so a device's change draws only what shows it.
type HomeProps = {
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
};

export function Home(props: HomeProps) {
  const live = useMemo(() => createLiveFeed(), []);
  return (
    <HomeDevicesProvider live={live}>
      <HomeScreen {...props} live={live} />
    </HomeDevicesProvider>
  );
}

function HomeScreen(
  props: HomeProps & { live: ReturnType<typeof createLiveFeed> },
) {
  const { host, onHostMoved, onCertificateChanged, live } = props;
  const { status: core, checkNow } = useCoreStatus();
  const [updateRunning, setUpdateRunning] = useState(false);
  const liveConnection = useRef<ReturnType<typeof connectLive>>(undefined);
  const [found, setFound] = useState(false);
  const [certificateNotValid, setCertificateNotValid] = useState(false);
  const [reachedCore, setReachedCore] = useState(false);
  const [me, setMe] = useState<Me>();
  // This client draws as chosen for it on any client.
  useDrawing(me);
  const [routes, setRoutes] = useState<Route[]>([]);
  // A device's detail covers the screen, inside it.
  const [screen, setScreen] = useState<HTMLDivElement | null>(null);
  const sidebarTrigger = useRef<HTMLButtonElement>(null);
  const {
    installed,
    isWaiting: appsWaiting,
    read: readApps,
    stop: stopApps,
    appChanged,
    appAdded,
  } = useInstalledApps(live);
  const refreshId = useRef(0);
  const { dashboards, rename, home } = useDashboards(live);
  const { pins, change: changePins } = usePins(live);
  const { current: dashboard, show: showDashboard } =
    useCurrentDashboard(dashboards);
  // Edit Home, until Done, or until the page or dashboard on show changes.
  const [editingHome, setEditingHome] = useState(false);
  const devicesSummary = useDevicesSummary();
  usePreloadSystemPages(devicesSummary.loaded);
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
  // The device whose detail is open, kept out of Home's state.
  const openedDevice = useOpenDevice();
  const { open: openDevice, openFromRoom: openRoomDevice } = openedDevice;
  const closeDevice = openedDevice.close;
  const sectionEntities = useSectionEntities(
    live,
    installed,
    devicesSummary.fail,
  );
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
    const [nextMe] = await Promise.allSettled([
      coreJson<Me>("/api/auth/me"),
      readApps(),
    ]);
    if (requestId !== refreshId.current) return;
    if (nextMe.status === "fulfilled") setMe(nextMe.value);
  }, [readApps]);

  // Only Me, when the core says this client's own record changed, such as
  // how it draws: nothing else needs reading again for that.
  const readMe = useCallback(() => {
    const requestId = ++refreshId.current;
    void coreJson<Me>("/api/auth/me")
      .then((next) => {
        if (requestId === refreshId.current) setMe(next);
      })
      .catch(() => undefined);
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
    let isLive = false;
    // Refresh snapshots while shown. A hidden window still checks its
    // token if the live connection cannot tell it it was revoked.
    const timer = setInterval(() => {
      if (isShown()) update();
      else if (!isLive) void coreJson("/api/auth/me").catch(() => undefined);
    }, 30_000);
    let lastReturn: { event: "focus" | "visibility"; time: number } | undefined;
    const resume = (event: NonNullable<typeof lastReturn>["event"]) => {
      if (!isShown()) return;
      const time = performance.now();
      // The two events for one return can arrive in separate tasks.
      if (
        lastReturn &&
        lastReturn.event !== event &&
        time - lastReturn.time < 100
      ) {
        lastReturn = undefined;
        return;
      }
      lastReturn = { event, time };
      update();
    };
    const focus = () => resume("focus");
    const stopShown = onShown(
      () => resume("visibility"),
      () => {
        lastReturn = undefined;
      },
    );
    window.addEventListener("focus", focus);
    // The apps read again whenever the connection comes back, and follow
    // its updates in between. Revoking this client elsewhere closes it at
    // once; any other close asks whether the core is still there.
    const connection = connectLive(
      (state) => {
        isLive = state === "live";
        if (isLive) update();
        if (state === "offline") checkNow();
      },
      live.publish,
      readMe,
    );
    liveConnection.current = connection;
    return () => {
      refreshId.current += 1;
      stopApps();
      clearInterval(timer);
      stopShown();
      window.removeEventListener("focus", focus);
      connection.stop();
      liveConnection.current = undefined;
    };
  }, [found, refresh, readMe, stopApps, live, host.url, host.token, checkNow]);

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
          ? isSettingsRouteAvailable(route, installed)
          : route.app === placePages ||
            route.app === appsPage ||
            route.app === automationsApp.id ||
            apps.some(
              (app) => app.info.id === route.app && showsPage(app, route.page),
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
  const isAppPage = !!route && showsPage(routeApp, route.page);
  // The shell's own page for an app that brings none, over its colours.
  const isDefaultPage =
    isAppPage && route?.page === mainPage && hasDefaultPage(routeApp);
  // A page another of its app's pages opened, such as an editor, has its
  // own way out, and opening settings over it would lose what it holds.
  const openedByItsApp = routes.length > 1 && routes.at(-2)?.app === route?.app;
  const onDashboard = routes.length === 0;
  const isEditingHome =
    editingHome && onDashboard && dashboard?.kind === "home";
  useEffect(() => {
    if (!onDashboard || dashboard?.kind !== "home") setEditingHome(false);
  }, [onDashboard, dashboard?.kind]);
  const settings = useSettingsNavigation(routes, setRoutes, installed);
  const openAutomations = () =>
    setRoutes([{ app: automationsApp.id, page: "main", params: {} }]);
  // Somewhere new from the sidebar, which takes the floating one away.
  const go = (next: Route[]) => {
    setRoutes(next);
    sidebar.close();
  };

  // What Apps lists, and what may be pinned.
  const listed = listedApps(
    [
      { ...settingsApp, onOpen: settings.openSettings },
      { ...automationsApp, onOpen: openAutomations },
    ],
    installed,
    setRoutes,
  );

  // A dashboard and a room's or category's page are in Evening over the
  // dashboard's background, along with the menus portalled out of them; an
  // app's page, Apps included, fills its panel in the device's mode.
  const appPage = route !== undefined && route.app !== placePages;
  const deviceMode = prefersDark ? "evening" : "day";
  // The default page is in Evening too, its white ink over the app's colours.
  const mode = appPage && !isDefaultPage ? deviceMode : "evening";
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
  const overlayHost = useMemo(
    () => ({ container: screen, onCovering: sidebar.setCovered }),
    [screen, sidebar.setCovered],
  );
  useEffect(() => {
    if (isVeiled) closeDevice();
  }, [isVeiled, closeDevice]);

  return (
    // How the household reads things, for the shell's pages and apps' alike.
    <Household
      temperatureUnit={devicesSummary.temperatureUnit}
      timeZone={devicesSummary.timeZone}
      hourCycle={devicesSummary.hourCycle}
    >
      <OverlayHostProvider value={overlayHost}>
        <ShellFrame
          screenRef={setScreen}
          layout={sidebar}
          isPlace={!appPage}
          place={dashboard && dashboardFrame[dashboard.background]}
          deviceMode={deviceMode}
          panelBackground={
            isDefaultPage && routeApp
              ? appBackdrop(routeApp.info)
              : appPage
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
              account={
                me?.person
                  ? {
                      person: me.person,
                      onSettings: settings.openSettings,
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
                    disabled: !devicesSummary.loaded || devicesSummary.none,
                    open: () => setEditingHome(true),
                  }}
                  editingHome={
                    isEditingHome
                      ? { onDone: () => setEditingHome(false) }
                      : undefined
                  }
                  pageSlot={setPageSlot}
                  appSettings={
                    route && routeApp && isAppPage && !openedByItsApp
                      ? {
                          name: routeApp.info.name,
                          open: settingsOf(route.app),
                        }
                      : undefined
                  }
                />
                <PageBarSlot.Provider value={pageSlot}>
                  <main
                    ref={settings.scrollArea}
                    className={`page${appPage ? " app-page" : ""}`}
                  >
                    <HomePage
                      route={route}
                      routeDepth={routes.length}
                      routeApp={routeApp}
                      isAppPage={isAppPage}
                      isDefaultPage={isDefaultPage}
                      openedByItsApp={openedByItsApp}
                      back={back}
                      opener={opener}
                      setRoutes={setRoutes}
                      settingsOf={settingsOf}
                      settings={settings}
                      listed={listed}
                      appsWaiting={appsWaiting}
                      installed={installed}
                      pins={pins}
                      changePins={changePins}
                      appChanged={appChanged}
                      appAdded={appAdded}
                      live={live}
                      ask={ask}
                      core={core}
                      shownStatus={shownStatus}
                      statusFailed={statusFailed}
                      setUpdateRunning={setUpdateRunning}
                      me={me}
                      dashboard={dashboard}
                      dashboards={dashboards}
                      home={home}
                      isEditingHome={isEditingHome}
                      showDashboard={showDashboard}
                      setEditingHome={setEditingHome}
                      openDevice={openDevice}
                      openRoomDevice={openRoomDevice}
                      sectionEntities={sectionEntities}
                      widgetCards={widgetCards}
                      hostUrl={host.url}
                      deviceMode={deviceMode}
                      isVeiled={isVeiled}
                    />
                  </main>
                </PageBarSlot.Provider>
              </div>
              {/* Over the page, under the top bar; it takes the page's
                  background, so it sits beside the page, not in it. */}
              {!isDefaultPage && (
                <div aria-hidden="true" className="top-fade" />
              )}
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
          <OpenDeviceDetail
            opened={openedDevice}
            container={screen}
            apps={apps}
            live={live}
            home={home}
            isAway={veil !== undefined}
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
          <StickOffer
            live={live}
            isOnline={!isVeiled && core.state === "online"}
            onAdded={(app) => {
              appAdded(app);
              settingsOf(app.id)();
            }}
          />
        </ShellFrame>
      </OverlayHostProvider>
    </Household>
  );
}

// The unit the household shows temperatures in, and the home clock, in
// which the shell and widgets' cards work out and write days and times.
function Household(props: {
  temperatureUnit: TemperatureUnit | undefined;
  timeZone: string | undefined;
  hourCycle: HourCycle | undefined;
  children: ReactNode;
}) {
  return (
    <TemperatureUnitProvider unit={props.temperatureUnit}>
      <HomeTimeZoneProvider
        timeZone={props.timeZone}
        hourCycle={props.hourCycle}
      >
        {props.children}
      </HomeTimeZoneProvider>
    </TemperatureUnitProvider>
  );
}

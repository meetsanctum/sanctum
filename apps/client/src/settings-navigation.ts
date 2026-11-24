import type { AppInfo } from "@meetsanctum/app-sdk";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import type { Route } from "./apps";
import type { SetupTarget } from "./setup-guide";
import {
  appSettingsPage,
  devicesSettingsPage,
  settingsApp,
  settingsPageTitle,
  setupPage,
} from "./system-apps";

const overview: Route = { app: settingsApp.id, page: "main", params: {} };

export function isSettingsRouteAvailable(
  route: Route,
  apps: readonly AppInfo[],
) {
  return (
    route.page !== appSettingsPage ||
    apps.some((app) => app.id === route.params.id)
  );
}

export function useSettingsNavigation(
  routes: readonly Route[],
  show: (routes: Route[]) => void,
  apps: readonly AppInfo[],
) {
  const [setupStep, setSetupStep] = useState<SetupTarget>();
  const onStarted = useCallback(() => setSetupStep(undefined), []);
  const remembered = useRef<Route>(undefined);
  const scrollArea = useRef<HTMLElement>(null);
  const route = routes.at(-1);
  const parent = routes.at(-2);
  const [first, area] = routes;
  const isInSettings =
    first?.app === overview.app && first.page === overview.page;

  // Keep the first page above the overview, which can be reopened with
  // Back to Settings. A removed app's settings can no longer be reopened.
  useEffect(() => {
    if (isInSettings) remembered.current = area;
    if (
      remembered.current &&
      !isSettingsRouteAvailable(remembered.current, apps)
    ) {
      remembered.current = undefined;
    }
  }, [area, apps, isInSettings]);

  useLayoutEffect(() => {
    if (route?.app === settingsApp.id && scrollArea.current) {
      scrollArea.current.scrollTop = 0;
    }
  }, [route]);

  function openOverview() {
    setSetupStep(undefined);
    show([overview]);
  }

  function openSettings() {
    const area = remembered.current;
    if (isInSettings || !area || !isSettingsRouteAvailable(area, apps)) {
      openOverview();
      return;
    }
    setSetupStep(undefined);
    show([overview, area]);
  }

  function openSetup(step: SetupTarget) {
    setSetupStep(step);
    show([
      overview,
      { app: settingsApp.id, page: setupPage[step], params: {} },
    ]);
  }

  const backTo =
    parent?.app === settingsApp.id
      ? settingsPageTitle(parent.page, parent.params, apps)
      : route?.page === devicesSettingsPage && route.app === settingsApp.id
        ? apps.find((app) => app.id === parent?.app)?.name
        : undefined;

  return {
    openSettings,
    openOverview,
    openSetup,
    scrollArea,
    backTo,
    start:
      setupStep && route?.page === setupPage[setupStep] ? setupStep : undefined,
    onStarted,
  };
}

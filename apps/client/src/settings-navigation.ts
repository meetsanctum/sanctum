import type { AppInfo } from "@meetsanctum/app-sdk";
import { useCallback, useEffect, useRef, useState } from "react";

import type { Route } from "./apps";
import type { SetupTarget } from "./setup-guide";
import {
  appSettingsPage,
  devicesSettingsPage,
  householdSettingsPage,
  peopleSettingsPage,
  personSettingsPage,
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
  const remembered = useRef<Route[]>([]);
  const route = routes.at(-1);
  const parent = routes.at(-2);
  const [first] = routes;
  const isInSettings =
    first?.app === overview.app && first.page === overview.page;

  // Keep the pages above the overview, such as Devices and a category's
  // page over it, which reopen where they were with Back to Settings. A
  // removed app's settings can no longer be reopened, nor a page over them.
  useEffect(() => {
    if (isInSettings) {
      remembered.current = routes.slice(1).map((each) => {
        if (each.page !== personSettingsPage || !each.params.added) return each;
        const { added: _, ...params } = each.params;
        return { ...each, params };
      });
    }
    const gone = remembered.current.findIndex(
      (each) => !isSettingsRouteAvailable(each, apps),
    );
    if (gone !== -1) remembered.current = remembered.current.slice(0, gone);
  }, [routes, apps, isInSettings]);

  function openOverview() {
    setSetupStep(undefined);
    show([overview]);
  }

  function openSettings() {
    const above = remembered.current;
    if (
      isInSettings ||
      above.length === 0 ||
      !above.every((each) => isSettingsRouteAvailable(each, apps))
    ) {
      openOverview();
      return;
    }
    setSetupStep(undefined);
    show([overview, ...above]);
  }

  // A person's page, under People, as if opened from there.
  function openPerson(id: string) {
    setSetupStep(undefined);
    show([
      overview,
      { app: settingsApp.id, page: peopleSettingsPage, params: {} },
      { app: settingsApp.id, page: personSettingsPage, params: { id } },
    ]);
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
      : route?.app === settingsApp.id &&
          (route.page === devicesSettingsPage ||
            route.page === householdSettingsPage)
        ? (route.params.from ??
          apps.find((app) => app.id === parent?.app)?.name)
        : undefined;

  return {
    openSettings,
    openOverview,
    openPerson,
    openSetup,
    backTo,
    start:
      setupStep && route?.page === setupPage[setupStep] ? setupStep : undefined,
    onStarted,
  };
}

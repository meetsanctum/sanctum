import type { DashboardInfo } from "@meetsanctum/app-sdk";

import type { Route } from "./apps";
import { appsPage, type ListedApp } from "./apps-page";
import { dashboardBackground } from "./dashboards";
import { placePages, SidebarPlaces } from "./place-pages";
import { SidebarContent } from "./sidebar";
import { SidebarPins } from "./sidebar-pins";
import type { SidebarLayout } from "./sidebar-state";
import type { Devices } from "./use-devices";
import type { Account } from "./user-menu";

// The signed-in screen's sidebar, docked or floating: the household's pins
// this client can open, in their order, each marked while its app is on
// show, then Apps, marked on Apps and on the page of an app that isn't
// pinned; the home's dashboards; and the categories and rooms. Choosing
// anything replaces what is on show and takes a floating sidebar away.
export function HomeSidebar(props: {
  isFloating: boolean;
  isVeiled: boolean;
  layout: SidebarLayout;
  routes: Route[];
  /** What Apps lists, and what may be pinned. */
  listed: ListedApp[];
  pins: string[] | undefined;
  dashboards: DashboardInfo[] | undefined;
  /** The dashboard this client shows. */
  shown: DashboardInfo | undefined;
  showDashboard: (id: string) => void;
  go: (routes: Route[]) => void;
  devices: Devices;
  account?: Account;
}) {
  const { layout, routes, go } = props;
  const route = routes.at(-1);
  const pinned = props.pins?.flatMap((id) => {
    const app = props.listed.find((each) => each.id === id);
    return app ? [app] : [];
  });
  const appsCurrent =
    route?.app === appsPage ||
    (route !== undefined &&
      route.app !== placePages &&
      !pinned?.some((app) => app.id === route.app));
  const openApps = () => go([{ app: appsPage, page: "main", params: {} }]);
  return (
    <SidebarContent
      isInert={props.isVeiled || (!props.isFloating && !layout.docked)}
      toggle={
        props.isFloating
          ? {
              label: layout.canDock
                ? "Keep the sidebar shown"
                : "Hide the sidebar",
              onClick: layout.keepShown,
            }
          : undefined
      }
      pins={
        <SidebarPins
          apps={pinned?.map((app) => ({
            ...app,
            current: route?.app === app.id,
            onOpen: () => {
              app.onOpen();
              layout.close();
            },
          }))}
          appsCurrent={appsCurrent}
          openApps={openApps}
          pinApps={openApps}
        />
      }
      dashboards={(props.dashboards ?? []).map(
        ({ id, name, background, kind }) => ({
          id,
          name,
          background: dashboardBackground[background],
          home: kind === "home",
          current: routes.length === 0 && id === props.shown?.id,
          onSelect: () => {
            props.showDashboard(id);
            go([]);
          },
        }),
      )}
      account={
        props.account && {
          ...props.account,
          onSettings: () => {
            props.account?.onSettings();
            layout.close();
          },
        }
      }
      onMenuOpenChange={layout.hold}
    >
      <SidebarPlaces
        devices={props.devices}
        current={
          routes.length === 1 && route?.app === placePages
            ? { page: route.page, params: route.params }
            : null
        }
        open={(page, params) =>
          // A place in the sidebar replaces what is on show.
          go([{ app: placePages, page, params }])
        }
      />
    </SidebarContent>
  );
}

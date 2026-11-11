import type { AppInfo } from "@meetsanctum/app-sdk";
import naturalLight from "@meetsanctum/natural-light/ui";
import moods from "@meetsanctum/moods/ui";
import weather from "@meetsanctum/weather/ui";
import zigbee from "@meetsanctum/zigbee/ui";
import {
  AppScope,
  createAppClient,
  mainPage,
  type AppClient,
  type AppUi,
  type CoreBridge,
  type PageParams,
} from "@meetsanctum/ui-sdk";
import type { ReactNode } from "react";

import { pageMismatch, type PageMismatch } from "./page-mismatch";

// The apps whose UIs the shell hosts. System and official apps' pages load
// straight into the shell, so their UIs are bundled here; the core says
// which of them the home has installed (GET /api/apps). Each gets a client
// limited to its own actions and the core calls its permissions allow.

const bundled: readonly AppUi[] = [moods, naturalLight, weather, zigbee];

export type HostedApp = {
  info: AppInfo;
  ui: AppUi;
  client: AppClient;
  /** That this client's pages don't work with the version it runs, if they don't. */
  mismatch?: PageMismatch;
};

/** What is on show when it is not the dashboard: one of an app's pages. */
export type Route = { app: string; page: string; params: PageParams };

/** The installed apps the shell has a UI for, in the core's order. */
export function hostedApps(
  installed: readonly AppInfo[],
  bridge: CoreBridge,
): HostedApp[] {
  return installed.flatMap((info) => {
    const ui = bundled.find((each) => each.id === info.id);
    if (!ui) return [];
    const client = createAppClient(info, bridge);
    const mismatch = pageMismatch(info, ui);
    // None of its UI is mounted, so none of it can call what isn't there. What it
    // adds to the home is data, which the shell draws.
    return mismatch
      ? [
          {
            info,
            ui: {
              ...ui,
              Provider: undefined,
              pages: {},
              devicePages: undefined,
            },
            client,
            mismatch,
          },
        ]
      : [{ info, ui, client }];
  });
}

/** Whether the app overview can open the app: it has a main page. */
export const opens = (app: HostedApp) => hasPage(app, mainPage);

/** A page must be both installed on the core and bundled in this client. */
export function pageOf(app: HostedApp | undefined, page: string) {
  return app?.info.pages.includes(page) && Object.hasOwn(app.ui.pages, page)
    ? app.ui.pages[page]
    : undefined;
}

/** Whether a page can be opened: to show, or to say why it doesn't match. */
export const hasPage = (app: HostedApp | undefined, page: string) =>
  !!pageOf(app, page) || (!!app?.mismatch && app.info.pages.includes(page));

// Every hosted app's scope and provider, around everything the shell shows,
// so each app's pages share what it loads. Each page gets its own scope
// again where it is shown.
export function AppHosts(props: { apps: HostedApp[]; children: ReactNode }) {
  return props.apps.reduceRight<ReactNode>((children, { info, ui, client }) => {
    const Provider = ui.Provider;
    return (
      <AppScope key={info.id} client={client}>
        {Provider ? <Provider>{children}</Provider> : children}
      </AppScope>
    );
  }, props.children);
}

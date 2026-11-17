import type { AppInfo } from "@meetsanctum/app-sdk";
import {
  createAppClient,
  mainPage,
  type AppClient,
  type CoreBridge,
  type PageParams,
} from "@meetsanctum/ui-sdk";

// The installed apps, in the core's order, whose pages the shell shows in
// frames the core serves (frames/): the core says which apps the home has
// and which pages each has (GET /api/apps), and the shell bundles none of
// them. Each gets a client limited to its own actions and the core calls
// its permissions allow, which runs what its pages ask for.

export type HostedApp = {
  info: AppInfo;
  client: AppClient;
};

/** What is on show when it is not the dashboard: one of an app's pages. */
export type Route = { app: string; page: string; params: PageParams };

/** The installed apps, each with its client. */
export function hostedApps(
  installed: readonly AppInfo[],
  bridge: CoreBridge,
): HostedApp[] {
  return installed.map((info) => ({
    info,
    client: createAppClient(info, bridge),
  }));
}

/** Whether a page can be opened: the version the app runs has it. */
export const hasPage = (app: HostedApp | undefined, page: string) =>
  !!app?.info.pages.includes(page);

/** Whether the app overview opens the app's own page: it has a main page. */
export const opens = (app: HostedApp) => hasPage(app, mainPage);

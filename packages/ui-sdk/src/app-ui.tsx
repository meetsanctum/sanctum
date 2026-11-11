import type { DeviceInfo } from "@meetsanctum/app-sdk";
import {
  createContext,
  useContext,
  type ComponentType,
  type ReactNode,
} from "react";

import type { AppClient } from "./client";

// What an app's UI brings to the shell: its pages and the pages it adds to
// devices' details.
// The sidebar, dashboards and room and category pages are the shell's: an
// app adds to a dashboard with a widget and to a room's page with a room
// section, which its manifest declares and the shell draws.
// System and official apps' UIs load straight into the shell, each inside
// its own AppScope, so its components reach its client with useAppClient().

export type PageParams = Record<string, string>;

/** The page the app overview opens, as manifests name it (@meetsanctum/app-sdk). */
export const mainPage = "main";

export type PageProps = {
  params: PageParams;
  /**
   * Opens another of the app's pages over this one. There is no Back: the
   * page opened needs its own way out, such as an editor's Cancel and Save,
   * which calls back().
   */
  open(page: string, params?: PageParams): void;
  /**
   * Leaves this page for the one that opened it: its own way out, or when
   * what it shows is gone.
   */
  back(): void;
  /**
   * Opens the app's preferences, the same page as Settings → Apps → the
   * app, over this one; Done beside its title returns here. For a quiet
   * place of the app's own.
   */
  openSettings(): void;
};

/** What a device page gets: the device, with the capabilities the app may read. */
export type DevicePageProps = { device: DeviceInfo };

export type AppUi = {
  /** The app's id, as its manifest gives it. */
  id: string;
  /** The app's version these pages came with, from its manifest. */
  version: string;
  /**
   * The oldest version of the app these pages work with. By default the one they
   * came with; going lower takes a test against that version's manifest.
   */
  oldestApp?: string;
  /**
   * Mounted once around everything the app shows, inside its scope, so its
   * pages and contributions share what it loads.
   */
  Provider?: ComponentType<{ children: ReactNode }>;
  /**
   * Its pages by name, as its manifest lists them; the app overview opens
   * main, if it has one, and a room section's link its page for a room,
   * with { placeId }.
   */
  pages: Record<string, ComponentType<PageProps>>;
  /**
   * The pages it adds to devices' details, by the ids its manifest declares
   * (provides.devicePages), such as Moods' Presses page for remotes.
   */
  devicePages?: Record<string, ComponentType<DevicePageProps>>;
};

export function defineAppUi(ui: AppUi): AppUi {
  return ui;
}

const AppClientContext = createContext<AppClient | null>(null);

/** Where the shell puts an app's UI: everything inside reaches that app's client. */
export function AppScope(props: { client: AppClient; children: ReactNode }) {
  return (
    <AppClientContext.Provider value={props.client}>
      {props.children}
    </AppClientContext.Provider>
  );
}

export function useAppClient(): AppClient {
  const client = useContext(AppClientContext);
  if (!client) {
    throw new Error("useAppClient() needs an AppScope around it");
  }
  return client;
}

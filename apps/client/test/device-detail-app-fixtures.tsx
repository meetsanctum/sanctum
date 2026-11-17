import type { AppInfo } from "@meetsanctum/app-sdk";
import { frameBridge, type AppClient } from "@meetsanctum/ui-sdk";

import type { HostedApp } from "../src/apps";

// The core's addresses for a device page and the kit it loads with.
export function devicePageAnswer(path: string, app: string) {
  if (path === "/api/pages/ticket") {
    return {
      ticket: "page_ticket",
      expiresAt: new Date(Date.now() + 8 * 24 * 60 * 60_000).toISOString(),
      kit: { version: "0.1.4", bridge: frameBridge, digest: "kit" },
    };
  }
  if (path === `/api/pages/apps/${app}`) return { digest: "page" };
  return undefined;
}

// An app that adds a page to remotes' details, which opens in its frame.
export function pressesApp(permissions: string[]): HostedApp {
  const info: AppInfo = {
    id: "test.presses",
    name: "Presses",
    version: "0.1.0",
    icon: null,
    pages: [],
    permissions,
    requests: [],
    state: "running",
    settings: null,
    provides: {
      entities: [],
      widgets: [],
      roomSections: [],
      devicePages: [
        { id: "test.presses", title: "Presses", kinds: ["button"] },
      ],
    },
  };
  return { info, client: { app: info } as AppClient };
}

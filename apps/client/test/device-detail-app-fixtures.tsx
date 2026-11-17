import type { AppInfo } from "@meetsanctum/app-sdk";
import type { AppClient } from "@meetsanctum/ui-sdk";

import type { HostedApp } from "../src/apps";

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

import type { AppInfo } from "@meetsanctum/app-sdk";
import {
  useAppClient,
  type AppClient,
  type DevicePageProps,
} from "@meetsanctum/ui-sdk";

import type { HostedApp } from "../src/apps";

// An app that adds a page to remotes' details, drawn in its own scope.
function PressesPage(props: DevicePageProps) {
  const client = useAppClient();
  return (
    <p>
      {client.app.id} for {props.device.name}:{" "}
      {props.device.capabilities.map((each) => each.kind).join(", ")}
    </p>
  );
}
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
  return {
    info,
    ui: {
      id: "test.presses",
      version: "1.0.0",
      pages: {},
      devicePages: { "test.presses": PressesPage },
    },
    client: { app: info } as AppClient,
  };
}

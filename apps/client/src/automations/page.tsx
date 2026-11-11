import type { AppInfo } from "@meetsanctum/app-sdk";
import type { LiveFeed, PageParams } from "@meetsanctum/ui-sdk";
import { useMemo } from "react";

import type { useDevices } from "../use-devices";
import { AutomationPage } from "./automation";
import { namesOf, useAutomations } from "./data";
import { EditorPage } from "./editor";
import type { Home } from "./fields";
import { AutomationsList } from "./list";

// Automations, a system app: the household's workflows, which everyone may
// read, make, change, run and delete. It comes with Sanctum and has no
// Remove; the app overview lists it like any app. Its pages: main, the list;
// automation, one with its history; edit, the editor, for a new one without
// an id.

export const automationsApp = {
  id: "sanctum.automations",
  name: "Automations",
  icon: { glyph: "sparkles", color: "blossom" },
} as const;

export function AutomationsPage(props: {
  page: string;
  params: PageParams;
  open(page: string, params?: PageParams): void;
  back(): void;
  apps: readonly AppInfo[];
  devices: ReturnType<typeof useDevices>;
  live: LiveFeed;
  /** Opens an app's settings, over Automations. */
  openAppSettings(app: string): void;
  openStatus(): void;
  /** The shell's sheet, for a piece that needs a permission that is off. */
  ask(app: string, permissions: readonly string[]): Promise<boolean>;
}) {
  const automations = useAutomations(props.live);
  const { places, devices } = props.devices;
  const names = useMemo(
    () => namesOf(places, devices, props.apps, automations.entities),
    [places, devices, props.apps, automations.entities],
  );
  const home = useMemo<Home>(
    () => ({ places, devices, entities: automations.entities }),
    [places, devices, automations.entities],
  );

  if (props.page === "automation" && props.params.id) {
    return (
      <AutomationPage
        id={props.params.id}
        automations={automations}
        apps={props.apps}
        names={names}
        people={automations.people}
        open={props.open}
        back={props.back}
        openAppSettings={props.openAppSettings}
        openStatus={props.openStatus}
      />
    );
  }
  if (props.page === "edit") {
    return (
      <EditorPage
        id={props.params.id}
        automations={automations}
        apps={props.apps}
        home={home}
        names={names}
        back={props.back}
        ask={props.ask}
      />
    );
  }
  return (
    <AutomationsList
      automations={automations}
      apps={props.apps}
      names={names}
      open={props.open}
    />
  );
}

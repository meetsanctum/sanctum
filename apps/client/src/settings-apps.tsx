import type { AppInfo } from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { ChevronRight } from "lucide-react";

import { AppIcon } from "./app-icon";
import { plainIcon } from "./app-settings";
import { Row, Section } from "./components";

// Settings → Apps: the apps the home has installed, each opening its own
// page, Settings → Apps → the app (app-settings.tsx), which the app's own
// pages open too.

/** Settings' page for one app, by its id. */
export const appSettingsPage = "app";

export function AppsSection(props: {
  apps: AppInfo[];
  onOpen: (appId: string) => void;
}) {
  return (
    <Section id="settings-apps" title="Apps">
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {props.apps.map((app) => (
          <li key={app.id}>
            <Button
              variant="row"
              size="row"
              type="button"
              onClick={() => props.onOpen(app.id)}
              className="-mx-2.5 w-[calc(100%+20px)]"
            >
              <AppIcon
                icon={app.icon ?? plainIcon}
                className="size-9 [&_svg]:size-5"
              />
              <Row title={app.name} detail={`Version ${app.version}`} />
              <ChevronRight
                aria-hidden="true"
                className="ms-auto size-4 shrink-0 text-muted-foreground"
              />
            </Button>
          </li>
        ))}
      </ul>
    </Section>
  );
}

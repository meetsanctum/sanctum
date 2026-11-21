import type { AppInfo, AvailableApp } from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { ChevronRight } from "lucide-react";
import { useState, type ReactNode } from "react";

import { AddAppSheet } from "./add-app-sheet";
import { DeleteAppData } from "./app-delete-data";
import { dayWords } from "./app-go-back";
import { AppIcon } from "./app-icon";
import { plainIcon } from "./app-settings";
import { useAvailableApps } from "./available-apps";
import { Row, Section } from "./components";

// Settings → Apps: the apps the home has installed, each opening its own
// page, Settings → Apps → the app (app-settings.tsx), which the app's own
// pages open too. Then Add apps, the apps the home could add, each with its
// Add, which opens its sheet (add-app-sheet.tsx); with nothing to add, it
// isn't there. One the household removed says until when its data is kept,
// since adding it back meanwhile brings back what it had, and offers to
// delete it now (app-delete-data.tsx).

/** Settings' page for one app, by its id. */
export const appSettingsPage = "app";

export function AppsSection(props: {
  apps: AppInfo[];
  onOpen: (appId: string) => void;
  // The way back of Settings' Apps page, which it leads.
  page?: ReactNode;
}) {
  return (
    <Section id="settings-apps" title="Apps" page={props.page}>
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

export function AddAppsSection(props: {
  apps: readonly AppInfo[];
  /** One was added, as the core lists it now. */
  onAdded: (app: AppInfo) => void;
}) {
  const { available, refresh } = useAvailableApps(props.apps);
  const [adding, setAdding] = useState<AvailableApp>();
  // The sheet shows the app as last read, and closes if it's gone, as when
  // another device added it.
  const shown = adding && available.find((app) => app.id === adding.id);
  return (
    <>
      {available.length > 0 && (
        <Section
          id="settings-add-apps"
          title="Add apps"
          hint={available.length === 1 ? "1 app" : `${available.length} apps`}
        >
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {available.map((app) => (
              <li key={app.id} className="flex flex-col gap-1">
                <div className="flex min-h-13 items-center gap-3">
                  <AppIcon
                    icon={app.icon ?? plainIcon}
                    className="size-9 [&_svg]:size-5"
                  />
                  <Row
                    title={app.name}
                    detail={
                      app.removed
                        ? `Removed on ${dayWords(app.removed.at)}. Its data is kept until ${dayWords(app.removed.keptUntil)}.`
                        : (app.summary ?? "")
                    }
                  />
                  <Button
                    variant="outline"
                    className="ms-auto shrink-0"
                    aria-label={`Add ${app.name}`}
                    onClick={() => setAdding(app)}
                  >
                    Add
                  </Button>
                </div>
                {app.removed && (
                  <div className="ps-12">
                    <DeleteAppData app={app} onDeleted={refresh} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
      <AddAppSheet
        key={shown?.id ?? "none"}
        app={shown}
        onAdded={(app) => {
          // A late answer leaves alone a sheet opened since for another app.
          setAdding((current) =>
            current?.id === app.id ? undefined : current,
          );
          props.onAdded(app);
        }}
        onClose={() => {
          setAdding(undefined);
          refresh();
        }}
      />
    </>
  );
}

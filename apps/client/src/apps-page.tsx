import type { AppIcon as AppIconInfo } from "@meetsanctum/app-sdk";
import { Button, Input, PageBar, PageBarButton } from "@meetsanctum/ui-sdk";
import { Minus, Pin, Plus, Search } from "lucide-react";
import { useState } from "react";

import { AppIcon } from "./app-icon";

/** Where Apps is on show, as a route's app. */
export const appsPage = "sanctum.apps";

/** An app with a page of its own, as Apps lists it. */
export type ListedApp = {
  id: string;
  name: string;
  icon: AppIconInfo;
  onOpen: () => void;
};

// Apps: the page the sidebar's last tile opens, an app's page like any
// other, full bleed in the device's mode. It lists Settings, Automations and
// every installed app with a page of its own, by name: a search field, then
// their icons with their names under them. Pin apps in the top bar pins them
// to the top of the sidebar for the household: the pinned first, in their
// order, each with a −, then the rest with a +, fainter, as in Edit Home;
// pressing one pins or unpins it, and Done ends it. Each visit starts
// afresh.
export function AppsPage(props: {
  apps: ListedApp[];
  /** The household's pinned apps, in their order; none until read. */
  pins: string[] | undefined;
  onPins: (apps: string[]) => void;
}) {
  const [isPinning, setPinning] = useState(false);
  const [query, setQuery] = useState("");
  const pins = props.pins ?? [];
  const search = query.trim().toLowerCase();
  const found = props.apps.filter((app) =>
    app.name.toLowerCase().includes(search),
  );
  const pinned = pins.flatMap((id) => {
    const app = props.apps.find((each) => each.id === id);
    return app ? [app] : [];
  });
  const others = props.apps.filter((app) => !pins.includes(app.id));
  const toggle = (app: ListedApp) =>
    props.onPins(
      pins.includes(app.id)
        ? pins.filter((id) => id !== app.id)
        : [...pins, app.id],
    );

  return (
    <>
      <PageBar title={isPinning ? "Pin apps" : "Apps"}>
        {isPinning ? (
          <Button variant="outline" onClick={() => setPinning(false)}>
            Done
          </Button>
        ) : (
          <PageBarButton
            icon={Pin}
            label="Pin apps"
            disabled={!props.pins}
            onClick={() => setPinning(true)}
          />
        )}
      </PageBar>
      {isPinning ? (
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-8">
          <p className="m-0 text-[15px] leading-[22px] text-muted-foreground">
            Pinned apps sit at the top of the sidebar, four to a row and in this
            order, on every device in the home. Press an app to pin or unpin it.
          </p>
          <AppGroup
            title="Pinned"
            empty="Nothing is pinned yet."
            apps={pinned}
            label={(app) => `Unpin ${app.name}`}
            badge="unpin"
            onPress={toggle}
          />
          <AppGroup
            title="Not pinned"
            empty="Every app is pinned."
            apps={others}
            label={(app) => `Pin ${app.name}`}
            badge="pin"
            onPress={toggle}
          />
        </div>
      ) : (
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-8">
          <div className="relative w-full max-w-[420px]">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label="Search apps"
              placeholder="Search apps"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="h-10 pl-9 text-[15px] md:text-[15px]"
            />
          </div>
          {found.length > 0 ? (
            <AppGrid
              apps={found}
              label={(app) => app.name}
              onPress={(app) => app.onOpen()}
            />
          ) : (
            <p className="m-0 text-[15px] leading-[22px] text-muted-foreground">
              No apps match “{query.trim()}”.
            </p>
          )}
        </div>
      )}
    </>
  );
}

function AppGroup(props: {
  title: string;
  empty: string;
  apps: ListedApp[];
  label: (app: ListedApp) => string;
  badge: "pin" | "unpin";
  onPress: (app: ListedApp) => void;
}) {
  return (
    <section className="flex flex-col gap-4">
      <h2 className="m-0 text-[15px] leading-[22px] font-medium">
        {props.title}
      </h2>
      {props.apps.length > 0 ? (
        <AppGrid
          apps={props.apps}
          label={props.label}
          badge={props.badge}
          onPress={props.onPress}
        />
      ) : (
        <p className="m-0 text-[15px] leading-[22px] text-muted-foreground">
          {props.empty}
        </p>
      )}
    </section>
  );
}

function AppGrid(props: {
  apps: ListedApp[];
  label: (app: ListedApp) => string;
  badge?: "pin" | "unpin";
  onPress: (app: ListedApp) => void;
}) {
  const Badge = props.badge === "unpin" ? Minus : Plus;
  return (
    <ul className="m-0 grid w-full list-none grid-cols-[repeat(auto-fill,minmax(6.5rem,1fr))] gap-x-3 gap-y-7 p-0">
      {props.apps.map((app) => (
        <li key={app.id} className="flex min-w-0 justify-center">
          <Button
            variant="ghost"
            size="app"
            aria-label={props.label(app)}
            onClick={() => props.onPress(app)}
          >
            <span className="relative">
              <AppIcon
                icon={app.icon}
                className={
                  props.badge === "pin" ? "size-16 opacity-55" : "size-16"
                }
              />
              {props.badge && (
                <span
                  aria-hidden="true"
                  className="absolute -top-2 -left-2 grid size-6 place-items-center rounded-full bg-foreground text-background"
                >
                  <Badge className="size-3.5" strokeWidth={2.5} />
                </span>
              )}
            </span>
            <span
              className={
                props.badge === "pin"
                  ? "max-w-full truncate opacity-55"
                  : "max-w-full truncate"
              }
            >
              {app.name}
            </span>
          </Button>
        </li>
      ))}
    </ul>
  );
}

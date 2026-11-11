import {
  type AppInfo,
  type DeviceInfo,
  type EntityInfo,
  type Room,
  type StaticManifest,
  type WorkflowInfo,
} from "@meetsanctum/app-sdk";
import { Button, PageBar, type LiveFeed } from "@meetsanctum/ui-sdk";
import { LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { AppAdds } from "./app-adds";
import { GoBack, useGoBackTo } from "./app-go-back";
import { AppIcon } from "./app-icon";
import { PermissionsSection } from "./app-permissions";
import { AppRunningSection } from "./app-running";
import {
  AppNotice,
  givenUpWords,
  needsWords,
  restartingWords,
  turningOffWords,
  waitingWords,
} from "./app-state";
import { productName } from "./brand";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { coreJson } from "./core-fetch";
import { PreferencesSection } from "./settings-preferences";

// Settings → Apps → the app: the same page for every app, drawn by the shell
// from the app's manifest and what the home knows now, so no app can hide,
// restyle or misstate what it may do. Its state first, and what needs
// someone, then its permissions with a switch each, its preferences, and
// what it adds to the home. Settings or the app's own pages open it; with no
// Back, Done beside its title returns there, since everything on it is saved
// as it changes.

// An app without an icon of its own, such as a driver, gets a plain one.
export const plainIcon = { glyph: "app-window", color: "graphite" } as const;

function stateWords(app: AppInfo) {
  const update = app.run?.update;
  const canShowProgress =
    app.state === "starting" ||
    app.state === "waiting" ||
    app.state === "restarting";
  if (update?.stage === "updating" && canShowProgress) {
    return { spinner: true, text: `Updating to ${update.to}` };
  }
  // Someone just asked, and it hasn't stopped yet.
  if (
    update?.stage === "goingBack" &&
    (canShowProgress || app.state === "running")
  ) {
    return { spinner: true, text: `Going back to ${update.to}` };
  }
  switch (app.state) {
    case "stopped":
      return {
        dot: "bg-destructive",
        text: `Not running · it starts again when ${productName} restarts`,
      };
    case "failed":
      return { dot: "bg-destructive", text: givenUpWords, danger: true };
    case "off":
      return { dot: "bg-muted-foreground", text: "Off" };
    case "paused":
      return {
        dot: "bg-muted-foreground",
        text: `Paused · ${needsWords(app)}`,
      };
    case "starting":
      return { spinner: true, text: "Starting" };
    case "waiting":
      return { dot: "bg-muted-foreground", text: waitingWords(app) };
    case "restarting":
      return { spinner: true, text: restartingWords(app) };
    default:
      return { dot: "bg-(--leaf)", text: "Running" };
  }
}

// Turning an app off, at the end of its settings. It changes every screen in the
// home and not only this one, so it asks first, naming what goes; Cancel is
// focused. Turning it back on asks nothing, since that only brings things back.
function TurnOff(props: { app: AppInfo; deviceCount: number }) {
  const { app } = props;
  const [isAsking, setIsAsking] = useState(false);
  const [problem, setProblem] = useState<string>();
  const turnOff = () => {
    setIsAsking(false);
    setProblem(undefined);
    coreJson<AppInfo>(`/api/apps/${encodeURIComponent(app.id)}/off`, {
      method: "POST",
      json: { off: true },
    }).catch(() =>
      setProblem(`${app.name} couldn't be turned off. Try again.`),
    );
  };
  return (
    <div className="flex shrink-0 flex-col items-start gap-2">
      <Button variant="outline" onClick={() => setIsAsking(true)}>
        Turn off {app.name}
      </Button>
      {problem && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {problem}
        </p>
      )}
      <Dialog open={isAsking} onOpenChange={setIsAsking}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Turn off {app.name}?</DialogTitle>
            <DialogDescription>
              {turningOffWords(app, props.deviceCount)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              autoFocus
              onClick={() => setIsAsking(false)}
            >
              Cancel
            </Button>
            <Button onClick={turnOff}>Turn off</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// What the counts are made of, read when the page opens and again when the
// app changes.
function useHomeNow(app: AppInfo) {
  const [manifest, setManifest] = useState<StaticManifest>();
  const [entities, setEntities] = useState<EntityInfo[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const id = app.id;
  const version = app.version;
  useEffect(() => {
    let isCurrent = true;
    const path = `/api/apps/${encodeURIComponent(id)}/manifest`;
    coreJson<StaticManifest>(path)
      .then((next) => {
        if (isCurrent) setManifest(next);
      })
      .catch(() => undefined);
    coreJson<EntityInfo[]>(`/api/entities?app=${encodeURIComponent(id)}`)
      .then((next) => {
        if (isCurrent) setEntities(next);
      })
      .catch(() => undefined);
    coreJson<WorkflowInfo[]>("/api/workflows")
      .then((next) => {
        if (isCurrent) setWorkflows(next);
      })
      .catch(() => undefined);
    return () => {
      isCurrent = false;
    };
  }, [id, version]);
  return { manifest, entities, workflows };
}

export function AppPage(props: {
  app: AppInfo;
  apps: readonly AppInfo[];
  devices: readonly DeviceInfo[];
  rooms: readonly Room[];
  live: LiveFeed;
  /** Home's background, which the previews stand on. */
  background: string;
  onChanged: (app: AppInfo) => void;
  openStatus: () => void;
  onDone: () => void;
}) {
  const { app } = props;
  const { manifest, entities, workflows } = useHomeNow(app);
  const goBackTo = useGoBackTo(app);
  const state = stateWords(app);
  const deviceCount = props.devices.filter(
    (device) => device.driver === app.id,
  ).length;
  // Turn off and Go back are at the page's end and what they did at its start, so
  // someone who scrolled down to press one would see only the button go.
  const start = useRef<HTMLDivElement>(null);
  const showsAtStart =
    app.state === "off" || app.run?.update?.stage === "goingBack";
  const showedAtStart = useRef(showsAtStart);
  useEffect(() => {
    if (showsAtStart && !showedAtStart.current) {
      start.current?.scrollIntoView({ block: "center" });
    }
    showedAtStart.current = showsAtStart;
  }, [showsAtStart]);
  return (
    <>
      <PageBar title={`${app.name} settings`}>
        <Button variant="outline" onClick={props.onDone}>
          Done
        </Button>
      </PageBar>
      <div ref={start} className="flex shrink-0 flex-col gap-3">
        <div className="flex items-center gap-3">
          <AppIcon
            icon={app.icon ?? plainIcon}
            className="size-12 [&_svg]:size-7"
          />
          <span className="flex min-w-0 flex-col gap-px leading-tight">
            <span className="text-sm font-medium">Version {app.version}</span>
            <span
              className={`flex items-center gap-1.5 text-[13px] leading-[18px] font-medium ${
                state.danger ? "text-destructive" : "text-muted-foreground"
              }`}
            >
              {state.spinner ? (
                <LoaderCircle
                  aria-hidden="true"
                  className="size-3 shrink-0 animate-spin"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className={`size-2 shrink-0 rounded-full ${state.dot}`}
                />
              )}
              {state.text}
            </span>
          </span>
        </div>
        {manifest?.summary && (
          <p className="m-0 text-[13px] leading-[18px] font-medium text-muted-foreground">
            {manifest.summary}
          </p>
        )}
      </div>
      <AppNotice
        app={app}
        permissionsAre="below"
        openStatus={props.openStatus}
        deviceCount={deviceCount}
      />
      {app.requests.length > 0 && (
        <PermissionsSection app={app} onChanged={props.onChanged} />
      )}
      <PreferencesSection app={app} live={props.live} />
      {manifest && (
        <AppAdds
          app={app}
          manifest={manifest}
          background={props.background}
          now={{
            apps: props.apps,
            devices: props.devices,
            rooms: props.rooms,
            entities,
            workflows,
          }}
        />
      )}
      {manifest && app.run && (
        <AppRunningSection
          app={app}
          manifest={manifest}
          lastUpdate={goBackTo}
        />
      )}
      <div className="flex shrink-0 flex-wrap items-start gap-2 empty:hidden">
        <GoBack app={app} to={goBackTo} />
        {app.state !== "off" && !app.alwaysOn && (
          <TurnOff app={app} deviceCount={deviceCount} />
        )}
      </div>
    </>
  );
}

import {
  Button,
  PageBar,
  type FrameContext,
  type PageParams,
} from "@meetsanctum/ui-sdk";
import type { AppInfo } from "@meetsanctum/app-sdk";
import { cn } from "cn";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { AppIcon, plainIcon } from "../app-icon";
import type { HostedApp } from "../apps";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";
import { KnotLoader } from "../knot-loader";
import { PageDoesntMatch } from "../page-mismatch";
import type { FrameEvent } from "./bridge";
import { possessive, useFrame, type FrameHousehold } from "./use-frame";

// An app's page in a frame of its own (use-frame.ts). Until the page says
// it's ready the top bar shows the app's name and the page stays in its
// colour; after 0.4 s two sections in its place say it's opening. The
// page's title and actions go in the shell's top bar, which the frame can't
// reach, and another of the app's pages shows in the same frame.

export function AppFrame(props: {
  app: HostedApp;
  page: string;
  params: PageParams;
  /** Changes each time the shell shows a page afresh, as a new route does. */
  shown: string;
  open: (page: string, params?: PageParams) => void;
  back: () => void;
  openSettings: () => void;
  /** Opens Settings at Household, for a page's link to the home's language. */
  openHousehold: (title?: string) => void;
  /** Opens a device's detail, one the app may read, as the bridge checks. */
  openDevice: (device: string) => void;
  /** Opens Add devices, saying the page's title for Back on the way out. */
  addDevices: (returnParams?: PageParams, title?: string) => void;
  mode: FrameContext["mode"];
  /** How the household reads things: its unit, its zone and its hours. */
  household: FrameHousehold | undefined;
  /** Whether the home is away, as while it updates. */
  isAway: boolean;
}) {
  const { app, mode, household } = props;
  const { name } = app.info;
  // The page's own title and actions for the top bar, once it says them.
  const [bar, setBar] = useState<Extract<FrameEvent, { type: "bar" }>>();
  const title = bar?.title;
  const latest = useRef(props);
  const latestTitle = useRef(title);
  latestTitle.current = title;
  const pageRevision = useRef(0);
  useLayoutEffect(() => {
    if (latest.current.shown !== props.shown) pageRevision.current++;
    latest.current = props;
  });

  const shown = useFrame({
    app,
    mode,
    household,
    isAway: props.isAway,
    pageRevision: () => pageRevision.current,
    setup: () => ({
      page: latest.current.page,
      params: latest.current.params,
      openHousehold: true,
    }),
    on(event) {
      switch (event.type) {
        case "failed":
          return setBar(undefined);
        case "bar":
          return setBar(event);
        case "open":
          return latest.current.open(event.page, event.params);
        case "back":
          return latest.current.back();
        case "openSettings":
          return latest.current.openSettings();
        case "openHousehold":
          return latest.current.openHousehold(latestTitle.current);
        case "openDevice":
          return latest.current.openDevice(event.device);
        case "addDevices":
          return latest.current.addDevices(
            event.returnParams,
            latestTitle.current,
          );
      }
    },
  });
  const { phase, failed } = shown;

  // A new frame starts with the app's name in the bar.
  const { id, version, build } = app.info;
  useEffect(() => setBar(undefined), [shown.frameKey, id, version, build]);

  const shownBefore = useRef(props.shown);
  useEffect(() => {
    if (shownBefore.current === props.shown) return;
    shownBefore.current = props.shown;
    const { page, params } = latest.current;
    if (phase === "opening" || phase === "ready") {
      // The app's name until the new page says its own title.
      setBar(undefined);
      shown.send({ type: "show", page, params });
    } else {
      shown.again();
    }
  }, [props.shown, phase, shown]);

  if (shown.mismatch) {
    return <PageDoesntMatch app={app.info} mismatch={shown.mismatch} />;
  }
  return (
    <>
      <PageBar
        title={title ?? name}
        actions={
          failed
            ? undefined
            : bar?.actions.map((action) => ({
                ...action,
                onPress: () =>
                  shown.send({
                    type: "press",
                    id: action.id,
                    revision: bar.revision,
                  }),
              }))
        }
      />
      <div className="relative flex min-h-0 grow flex-col">
        {failed ? (
          <DidntOpen
            app={app.info}
            hasStopped={phase === "stopped"}
            tryAgain={shown.tryAgain}
          />
        ) : (
          shown.showsLoader && <Opening name={name} isSlow={shown.isSlow} />
        )}
        <iframe
          key={shown.frameKey}
          {...shown.frameProps}
          title={title ?? name}
          // Full bleed to the panel's sides and foot, as the page it holds.
          className={cn(
            "-mx-6 -mb-6 min-h-0 grow border-0",
            failed ? "hidden" : phase !== "ready" && "opacity-0",
          )}
        />
      </div>
    </>
  );
}

// While it opens, two sections in the page's place, each a heading over a
// card, still rather than pulsing so a wall display has nothing to draw.
// They lie over the frame, which keeps its size, so the page lays itself
// out once. Past 5 s a line under them says it's taking longer than usual;
// in a short window the cards give up height so the line stays in view.
function Opening(props: { name: string; isSlow: boolean }) {
  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col gap-3 overflow-hidden">
      <Skeleton className="h-3.5 w-28 shrink-0" />
      <Skeleton className="h-54 min-h-0 rounded-lg" />
      <Skeleton className="mt-5 h-3.5 w-21 shrink-0" />
      <Skeleton className="h-38 min-h-0 rounded-lg" />
      <div
        role="status"
        aria-atomic="true"
        className={
          props.isSlow
            ? "mt-8 flex shrink-0 items-center justify-center gap-3 text-center"
            : "sr-only"
        }
      >
        {props.isSlow && (
          <KnotLoader className="size-7 shrink-0 text-(--secondary)" />
        )}
        <p className="m-0 text-muted-foreground">
          {props.isSlow
            ? `Opening ${props.name} is taking longer than usual.`
            : `Opening ${props.name}…`}
        </p>
      </div>
    </div>
  );
}

// A page that didn't open, or stopped working once drawn, in the middle of
// its place: the app's icon faded with a mark on it, what happened, that
// what the app adds to the home goes on, and Try again. Its cause, slow or
// missing files, isn't said: either way Try again is what there is to do.
function DidntOpen(props: {
  app: AppInfo;
  hasStopped: boolean;
  tryAgain: () => void;
}) {
  const { name } = props.app;
  return (
    <Empty role="alert">
      <EmptyHeader>
        <EmptyMedia className="relative">
          <AppIcon
            appId={props.app.id}
            icon={props.app.icon ?? plainIcon}
            className="opacity-40 grayscale-60"
          />
          <span className="absolute -end-2 -bottom-2 grid size-7 place-items-center rounded-lg bg-background">
            <svg viewBox="0 0 24 24" aria-hidden="true" className="size-6">
              <circle cx="12" cy="12" r="11" className="fill-(--ruby)" />
              <path
                d="M12 7v6m0 3.5v.01"
                className="stroke-(--white)"
                strokeWidth="2.4"
                strokeLinecap="round"
              />
            </svg>
          </span>
        </EmptyMedia>
        <EmptyTitle>
          {props.hasStopped
            ? `${possessive(name)} page stopped working`
            : `${possessive(name)} page didn't open`}
        </EmptyTitle>
        <EmptyDescription>
          What {name} adds to the home keeps working.
        </EmptyDescription>
      </EmptyHeader>
      <Button size="lg" onClick={props.tryAgain}>
        Try again
      </Button>
    </Empty>
  );
}

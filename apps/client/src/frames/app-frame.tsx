import {
  Button,
  PageBar,
  type FrameContext,
  type PageParams,
} from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { CircleAlert } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { NoticeCard } from "../app-state";
import type { HostedApp } from "../apps";
import { KnotLoader } from "../knot-loader";
import { PageDoesntMatch } from "../page-mismatch";
import type { FrameEvent } from "./bridge";
import { possessive, useFrame, type FrameHousehold } from "./use-frame";

// An app's page in a frame of its own (use-frame.ts). Until the page says
// it's ready the top bar shows the app's name and the page stays in its
// colour; after 0.4 s the knot loader says it's opening. The page's title
// and actions go in the shell's top bar, which the frame can't reach, and
// another of the app's pages shows in the same frame.

export function AppFrame(props: {
  app: HostedApp;
  page: string;
  params: PageParams;
  /** Changes each time the shell shows a page afresh, as a new route does. */
  shown: string;
  open: (page: string, params?: PageParams) => void;
  back: () => void;
  openSettings: () => void;
  /** Opens a device's detail, one the app may read, as the bridge checks. */
  openDevice: (device: string) => void;
  addDevices: (returnParams?: PageParams) => void;
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
        case "openDevice":
          return latest.current.openDevice(event.device);
        case "addDevices":
          return latest.current.addDevices(event.returnParams);
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
      {failed ? (
        <NoticeCard
          Icon={CircleAlert}
          isWrong
          title={
            phase === "stopped"
              ? `${possessive(name)} page stopped working`
              : `${possessive(name)} page didn't open`
          }
          line={[
            phase === "late" && "It didn't answer in time.",
            phase === "files" && "Its files didn't load.",
            `What ${name} adds to the home keeps working.`,
          ]
            .filter(Boolean)
            .join(" ")}
          action={
            <Button variant="outline" onClick={shown.tryAgain}>
              Try again
            </Button>
          }
        />
      ) : (
        shown.showsLoader && (
          <div role="status" className="flex items-center gap-3">
            <KnotLoader className="size-7 shrink-0 text-(--secondary)" />
            <p className="m-0 text-muted-foreground">Opening {name}</p>
          </div>
        )
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
    </>
  );
}

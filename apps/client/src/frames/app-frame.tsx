import type { TemperatureUnit } from "@meetsanctum/app-sdk";
import {
  Button,
  frameBridge,
  PageBar,
  type FrameContext,
  type PageParams,
} from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { CircleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { looksRunning, NoticeCard } from "../app-state";
import { getShell } from "../shell";
import type { HostedApp } from "../apps";
import { KnotLoader } from "../knot-loader";
import { PageDoesntMatch } from "../page-mismatch";
import { openBridge, type FrameBridge, type FrameEvent } from "./bridge";
import { forgetPageTicket, pageAddress } from "./page-ticket";

// An app's page in a frame of its own, loaded from the core under this
// client's page ticket, sandboxed with nothing to connect to but the shell.
// Until the page says it's ready the top bar shows the app's name and the
// page stays in its colour; after 0.4 s the knot loader says it's opening.
// The home comes first: while it's away the page's timer waits, so a home
// that's updating is never called a page failing. The app comes next: while
// it isn't running its own notice shows over the page. Only then the page:
// one that doesn't answer in 10 s, whose files didn't load, or that stopped
// working once drawn says so, with Try again, which loads it afresh.

// "newer" is a home whose kit speaks a newer bridge than this client.
type Phase = "opening" | "ready" | "late" | "files" | "stopped" | "newer";

const loaderAfterMs = 400;
const answerWithinMs = 10_000;

export function AppFrame(props: {
  app: HostedApp;
  page: string;
  params: PageParams;
  /** Changes each time the shell shows a page afresh, as a new route does. */
  shown: string;
  open: (page: string, params?: PageParams) => void;
  back: () => void;
  openSettings: () => void;
  mode: FrameContext["mode"];
  household:
    { temperatureUnit: TemperatureUnit; timeZone: string | null } | undefined;
  /** Whether the home is away, as while it updates. */
  isAway: boolean;
}) {
  const { app, mode, household } = props;
  const { name } = app.info;
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<Phase>("opening");
  // The page's own title and actions for the top bar, once it says them.
  const [bar, setBar] = useState<Extract<FrameEvent, { type: "bar" }>>();
  const title = bar?.title;
  // Where the frame loads from, with the code in its address. Each address
  // gets a frame of its own: one that differs only after its # would be a
  // jump within the page already there, which keeps the old code.
  const [src, setSrc] = useState<{ url: string; code: string }>();
  const [showsLoader, setShowsLoader] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  // The code of the address whose page has loaded once.
  const loads = useRef<{ code?: string }>({});
  const bridge = useRef<FrameBridge>(undefined);
  const context = useMemo<FrameContext>(
    () => ({
      mode,
      temperatureUnit: household?.temperatureUnit ?? null,
      timeZone: household?.timeZone ?? null,
    }),
    [mode, household?.temperatureUnit, household?.timeZone],
  );
  // What the frame's messages act on, as the shell has it now.
  const latest = useRef({ ...props, context });
  useEffect(() => {
    latest.current = { ...props, context };
  });

  // A frame afresh, for each try and each version the app runs.
  const { id, version } = app.info;
  useEffect(() => {
    let isCurrent = true;
    setPhase("opening");
    setBar(undefined);
    setSrc(undefined);
    setShowsLoader(false);
    const on = (event: FrameEvent) => {
      if (!isCurrent) return;
      switch (event.type) {
        case "ready":
          return setPhase((now) =>
            now === "opening" || now === "late" ? "ready" : now,
          );
        case "failed":
          return setPhase(event.reason);
        case "bar":
          return setBar(event);
        case "open":
          return latest.current.open(event.page, event.params);
        case "back":
          return latest.current.back();
        case "openSettings":
          return latest.current.openSettings();
      }
    };
    const code = helloCode();
    const opened = openBridge({
      frame: () => frame.current?.contentWindow ?? null,
      code,
      client: () => latest.current.app.client,
      setup: () => {
        const { app, page, params, context } = latest.current;
        return { type: "setup", app: app.info, page, params, context };
      },
      on,
    });
    bridge.current = opened;
    // The desktop app holds the frame to the address named here, with its
    // code (apps/desktop/src/frames.ts); a plain browser has no such check.
    const frames = getShell().frames;
    let named: string | undefined;
    pageAddress(id, code)
      .then(async ({ kit, url }) => {
        if (!isCurrent) return;
        if (kit?.bridge !== frameBridge) {
          return setPhase(kit && kit.bridge > frameBridge ? "newer" : "files");
        }
        if (frames) {
          named = url;
          if (!(await frames.allow(url)))
            throw new Error("Not a page's address");
          if (!isCurrent) return;
        }
        setSrc({ url, code });
      })
      .catch(() => {
        if (!isCurrent) return;
        forgetPageTicket();
        setPhase("files");
      });
    return () => {
      isCurrent = false;
      opened.close();
      bridge.current = undefined;
      if (named) void frames?.end(named);
    };
  }, [attempt, id, version]);

  // What changes while it's open, said to the page in it.
  useEffect(() => {
    bridge.current?.send({ type: "app", app: app.info });
    bridge.current?.renew();
  }, [app.info]);
  useEffect(() => {
    bridge.current?.send({ type: "context", context });
  }, [context]);
  const shownBefore = useRef(props.shown);
  useEffect(() => {
    if (shownBefore.current === props.shown) return;
    shownBefore.current = props.shown;
    const { page, params } = latest.current;
    if (phase === "opening" || phase === "ready") {
      // The app's name until the new page says its own title.
      setBar(undefined);
      bridge.current?.send({ type: "show", page, params });
    } else {
      setAttempt((each) => each + 1);
    }
  }, [props.shown, phase]);

  const isRunning = looksRunning(app.info);
  const waits = props.isAway || !isRunning;
  useEffect(() => {
    if (phase !== "opening" || waits) return;
    const loader = setTimeout(() => setShowsLoader(true), loaderAfterMs);
    const late = setTimeout(
      () => setPhase((now) => (now === "opening" ? "late" : now)),
      answerWithinMs,
    );
    return () => {
      clearTimeout(loader);
      clearTimeout(late);
    };
  }, [phase, waits, attempt, id, version]);

  if (phase === "newer") {
    return <PageDoesntMatch app={app.info} mismatch={{ needs: "client" }} />;
  }
  const failed =
    !waits && (phase === "late" || phase === "files" || phase === "stopped");
  return (
    <>
      <PageBar
        title={title ?? name}
        actions={bar?.actions.map((action) => ({
          ...action,
          onPress: () =>
            bridge.current?.send({
              type: "press",
              id: action.id,
              revision: bar.revision,
            }),
        }))}
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
            <Button
              variant="outline"
              onClick={() => {
                forgetPageTicket();
                setAttempt((each) => each + 1);
              }}
            >
              Try again
            </Button>
          }
        />
      ) : (
        phase === "opening" &&
        showsLoader && (
          <div role="status" className="flex items-center gap-3">
            <KnotLoader className="size-7 shrink-0 text-(--secondary)" />
            <p className="m-0 text-muted-foreground">Opening {name}</p>
          </div>
        )
      )}
      <iframe
        key={src?.code ?? "opening"}
        ref={frame}
        src={src?.url}
        title={title ?? name}
        sandbox="allow-scripts"
        allow=""
        referrerPolicy="no-referrer"
        // A page that loads again, reloaded or sent elsewhere by its own
        // code, would come back with a code its bridge has used: it gets a
        // frame afresh instead, with a new one.
        onLoad={() => {
          if (!src) return;
          if (loads.current.code === src.code) {
            setAttempt((each) => each + 1);
          } else {
            loads.current = { code: src.code };
          }
        }}
        // Full bleed to the panel's sides and foot, as the page it holds.
        className={cn(
          "-mx-6 -mb-6 min-h-0 grow border-0",
          failed ? "hidden" : phase !== "ready" && "opacity-0",
        )}
      />
    </>
  );
}

function possessive(name: string) {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

// The code a frame says hello with, which only its address carries.
function helloCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

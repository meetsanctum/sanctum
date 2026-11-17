import {
  frameBridge,
  type FrameContext,
  type ToFrame,
} from "@meetsanctum/ui-sdk";
import { useEffect, useRef, useState } from "react";

import { looksRunning } from "../app-state";
import type { HostedApp } from "../apps";
import { CoreError } from "../core-fetch";
import type { PageMismatch } from "../page-mismatch";
import { getShell } from "../shell";
import { openBridge, type FrameBridge, type FrameEvent } from "./bridge";
import { forgetPageTicket, pageAddress } from "./page-ticket";

// What every frame an app's page shows in does, an app's page or a device's:
// it loads from the core under this client's page ticket, sandboxed with
// nothing to connect to but the shell, says hello with the code in its
// address and gets its port. The home comes first: while it's away the
// timer waits, so a home that's updating is never called a page failing.
// The app comes next: while it isn't running, its own notice is the shell's.
// Only then the page: one that doesn't answer in 10 s, whose files didn't
// load, or that stopped working once drawn says so, and Try again loads it
// afresh. A page that can't work with this client or this home says which
// is too old instead (page-mismatch.tsx).

export type FramePhase =
  "opening" | "ready" | "late" | "files" | "stopped" | "mismatch";

const loaderAfterMs = 400;
const answerWithinMs = 10_000;

export function useFrame(options: {
  app: HostedApp;
  /** What the frame is told first: which page, and for a device page, its device. */
  setup: () => Pick<
    Extract<ToFrame, { type: "setup" }>,
    "page" | "params" | "device"
  >;
  context: FrameContext;
  /** Whether the home is away, as while it updates. */
  isAway: boolean;
  /** What else the page says: its bar, where to go, its size, a key. */
  on?: (event: FrameEvent) => void;
}) {
  const { app, context } = options;
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<FramePhase>("opening");
  const [mismatch, setMismatch] = useState<PageMismatch>();
  // Where the frame loads from, with the code in its address. Each address
  // gets a frame of its own: one that differs only after its # would be a
  // jump within the page already there, which keeps the old code.
  const [src, setSrc] = useState<{ url: string; code: string }>();
  const [showsLoader, setShowsLoader] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null);
  // The code of the address whose page has loaded once.
  const loads = useRef<{ code?: string }>({});
  const bridge = useRef<FrameBridge>(undefined);
  // What the frame's messages act on, as the shell has it now.
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  // A frame afresh, for each try and each build the app runs: an update,
  // or in development a saved change, once the stack has staged it.
  const { id, version, build } = app.info;
  useEffect(() => {
    let isCurrent = true;
    setPhase("opening");
    setMismatch(undefined);
    setSrc(undefined);
    setShowsLoader(false);
    const on = (event: FrameEvent) => {
      if (!isCurrent) return;
      if (event.type === "ready") {
        setPhase((now) =>
          now === "opening" || now === "late" ? "ready" : now,
        );
      } else if (event.type === "failed") {
        setPhase(event.reason);
      }
      latest.current.on?.(event);
    };
    const code = helloCode();
    const opened = openBridge({
      frame: () => frame.current?.contentWindow ?? null,
      code,
      client: () => latest.current.app.client,
      setup: () => ({
        type: "setup",
        app: latest.current.app.info,
        context: latest.current.context,
        ...latest.current.setup(),
      }),
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
        if (!kit) return setPhase("files");
        if (kit.bridge !== frameBridge) {
          // A kit that speaks a newer bridge needs a newer client, and one
          // that speaks an older one a newer home.
          setMismatch({
            needs: kit.bridge > frameBridge ? "client" : "sanctum",
          });
          return setPhase("mismatch");
        }
        if (frames) {
          named = url;
          if (!(await frames.allow(url)))
            throw new Error("Not a page's address");
          if (!isCurrent) return;
        }
        setSrc({ url, code });
      })
      .catch((error: unknown) => {
        if (!isCurrent) return;
        // A mismatch keeps the ticket, which other frames may hold: the
        // core keeps only a client's newest few.
        const needs = misfitOf(error);
        if (needs) {
          setMismatch({ needs });
          return setPhase("mismatch");
        }
        forgetPageTicket();
        setPhase("files");
      });
    return () => {
      isCurrent = false;
      opened.close();
      bridge.current = undefined;
      if (named) void frames?.end(named);
    };
  }, [attempt, id, version, build]);

  // What changes while it's open, said to the page in it.
  useEffect(() => {
    bridge.current?.send({ type: "app", app: app.info });
    bridge.current?.renew();
  }, [app.info]);
  useEffect(() => {
    bridge.current?.send({ type: "context", context });
  }, [context]);

  const waits = options.isAway || !looksRunning(app.info);
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
  }, [phase, waits, attempt, id, version, build]);

  const failed =
    !waits && (phase === "late" || phase === "files" || phase === "stopped");
  return {
    phase,
    /** Why the page can't open here, when it's this client or this home that's too old. */
    mismatch: phase === "mismatch" ? mismatch : undefined,
    failed,
    showsLoader: phase === "opening" && showsLoader && !failed,
    /** Says something to the page, once it has its port. */
    send: (message: ToFrame) => bridge.current?.send(message),
    /** Loads the page afresh, in a new frame with a new code. */
    again() {
      setAttempt((each) => each + 1);
    },
    /** Try again: a new ticket too, since another window may have ended this one. */
    tryAgain() {
      forgetPageTicket();
      setAttempt((each) => each + 1);
    },
    /** The frame element's key: a new element for each address. */
    frameKey: src?.code ?? "opening",
    /** What the frame element takes. */
    frameProps: {
      ref: frame,
      src: src?.url,
      sandbox: "allow-scripts",
      allow: "",
      referrerPolicy: "no-referrer" as const,
      // A page that loads again, reloaded or sent elsewhere by its own
      // code, would come back with a code its bridge has used: it gets a
      // frame afresh instead, with a new one.
      onLoad: () => {
        if (!src) return;
        if (loads.current.code === src.code) {
          setAttempt((each) => each + 1);
        } else {
          loads.current = { code: src.code };
        }
      },
    },
  };
}

// What the core says an app's pages need, when they don't fit its kit.
function misfitOf(error: unknown) {
  if (!(error instanceof CoreError) || error.status !== 404) return undefined;
  const { needs } = (error.body ?? {}) as { needs?: unknown };
  return needs === "sanctum" || needs === "pages" ? needs : undefined;
}

export function possessive(name: string) {
  return name.endsWith("s") ? `${name}'` : `${name}'s`;
}

// The code a frame says hello with, which only its address carries.
function helloCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    "",
  );
}

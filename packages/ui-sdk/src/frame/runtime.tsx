import type { AppInfo } from "@meetsanctum/app-sdk";
import { StrictMode, useEffect, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

import { AppScope, type AppUi, type PageParams } from "../app-ui";
import type { AppClient, LiveListener } from "../client";
import { HomeTimeZoneProvider } from "../home-time-zone";
import { PageBarSink, type PageBarAction } from "../page-bar";
import { TemperatureUnitProvider } from "../temperature-unit";
import {
  frameBridge,
  type FrameContext,
  type FrameHello,
  type FrameOperation,
  type FromFrame,
  type ToFrame,
} from "./protocol";

// An app's page in its frame: what the kit runs once the page's code has
// loaded. It says hello to its parent with the code in its address, takes
// the one port its parent sends back, and from then on knows only what
// comes over it: which app it is, which page to show and where, and the
// answers to what its page asks. Its page gets the same AppClient and
// PageProps it would in the shell, each call an operation the shell runs.

type Shown = {
  app: AppInfo;
  page: string;
  params: PageParams;
  context: FrameContext;
  // A new page on show starts afresh, as a new route does in the shell.
  generation: number;
};

/**
 * Starts an app's page in its frame. The entry the core writes calls it
 * with the page's module, which loads while the frame says hello.
 */
export function startFrame(load: () => Promise<{ default: AppUi }>) {
  const code = new URLSearchParams(location.hash.slice(1)).get("hello") ?? "";
  const loaded = load().then(
    (page): Loaded => ({ ui: page.default }),
    (error: unknown): Loaded => ({ failure: String(error) }),
  );
  const takePort = (event: MessageEvent) => {
    const data = event.data as { sanctum?: unknown } | null;
    if (event.source !== window.parent || data?.sanctum !== "port") return;
    const [port] = event.ports;
    if (!port) return;
    window.removeEventListener("message", takePort);
    connect(loaded, port);
  };
  window.addEventListener("message", takePort);
  const hello: FrameHello = { sanctum: "hello", code, bridge: frameBridge };
  // A frame of its own has no origin the shell can name, so any.
  window.parent.postMessage(hello, "*");
}

type Loaded = { ui: AppUi } | { failure: string };

function connect(loaded: Promise<Loaded>, port: MessagePort) {
  const send = (message: FromFrame) => {
    port.postMessage(message);
  };
  const waiting = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const listeners = new Set<LiveListener>();
  let nextId = 0;
  let ui: AppUi | undefined;
  let shown: Shown | undefined;
  let root: Root | undefined;
  // The top bar as last said to the shell, and its actions' handlers, the
  // latest ones: a press of what the shell drew at an older revision is
  // dropped.
  let bar = { said: "", revision: 0 };
  let presses = new Map<string, () => void>();
  const sayBar = (title: string, actions: readonly PageBarAction[]) => {
    presses = new Map(actions.map((action) => [action.id, action.onPress]));
    const drawn = actions.map(({ id, label, primary, disabled }) => ({
      id,
      label,
      ...(primary ? { primary: true } : {}),
      ...(disabled ? { disabled: true } : {}),
    }));
    const said = JSON.stringify([title, drawn]);
    if (said === bar.said) return;
    bar = { said, revision: bar.revision + 1 };
    send({ type: "bar", title, actions: drawn, revision: bar.revision });
  };
  // Said once: the page's files didn't load, or React gave up on it. An
  // error a page catches, or one in a handler that leaves it drawn, isn't.
  let hasFailed = false;
  const fail = (failed: Extract<FromFrame, { type: "failed" }>) => {
    if (hasFailed) return;
    hasFailed = true;
    send(failed);
  };

  const request = <T,>(operation: FrameOperation) =>
    new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      });
      send({ type: "request", id, ...operation });
    });

  // The page's client: AppClient's methods, each an operation the shell
  // runs through its own client for this app.
  const clientOf = (app: AppInfo): AppClient => ({
    app,
    call: (actionId, input) => request({ op: "call", actionId, input }),
    places: () => request({ op: "places" }),
    devices: () => request({ op: "devices" }),
    command: (command) => request({ op: "command", command }),
    entities: () => request({ op: "entities" }),
    settings: () => request({ op: "settings" }),
    ask: (permissions) =>
      request({
        op: "ask",
        permissions:
          typeof permissions === "string" ? [permissions] : [...permissions],
      }),
    capturePresses() {
      throw new Error("A page in a frame doesn't capture presses");
    },
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) send({ type: "subscribe", on: true });
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) send({ type: "subscribe", on: false });
      };
    },
  });

  const draw = () => {
    if (!ui || !shown || hasFailed) return;
    document.documentElement.dataset.mode = shown.context.mode;
    root ??= createRoot(
      document.body.appendChild(document.createElement("div")),
      {
        onUncaughtError: (error) =>
          fail({ type: "failed", reason: "stopped", message: String(error) }),
      },
    );
    root.render(
      <StrictMode>
        <Framed
          ui={ui}
          shown={shown}
          client={clientOf(shown.app)}
          send={send}
          fail={fail}
          sayBar={sayBar}
        />
      </StrictMode>,
    );
  };

  void loaded.then((page) => {
    if ("failure" in page) {
      return fail({ type: "failed", reason: "files", message: page.failure });
    }
    ui = page.ui;
    draw();
  });

  port.onmessage = (event: MessageEvent<ToFrame>) => {
    const message = event.data;
    switch (message.type) {
      case "setup":
        shown = {
          app: message.app,
          page: message.page,
          params: message.params,
          context: message.context,
          generation: 0,
        };
        return draw();
      case "app":
        if (shown) shown = { ...shown, app: message.app };
        return draw();
      case "context":
        if (shown) shown = { ...shown, context: message.context };
        return draw();
      case "show":
        // The shell puts the app's name back in the bar until the page
        // that shows says its own, even one the same as before.
        bar = { said: "", revision: bar.revision };
        if (shown) {
          shown = {
            ...shown,
            page: message.page,
            params: message.params,
            generation: shown.generation + 1,
          };
        }
        return draw();
      case "answer": {
        const found = waiting.get(message.id);
        if (!found) return;
        waiting.delete(message.id);
        if (message.ok) found.resolve(message.value);
        else {
          const error = new Error(message.error.message) as Error & {
            code?: string;
          };
          if (message.error.code) error.code = message.error.code;
          found.reject(error);
        }
        return;
      }
      case "live":
        for (const listener of listeners) listener.message?.(message.message);
        return;
      case "refresh":
        for (const listener of listeners) listener.refresh?.();
        return;
      case "press":
        if (message.revision === bar.revision) presses.get(message.id)?.();
        return;
    }
  };
}

function Framed(props: {
  ui: AppUi;
  shown: Shown;
  client: AppClient;
  send: (message: FromFrame) => void;
  fail: (failed: Extract<FromFrame, { type: "failed" }>) => void;
  sayBar: (title: string, actions: readonly PageBarAction[]) => void;
}) {
  const { ui, shown, client, send, fail, sayBar } = props;
  const Page = ui.pages[shown.page];
  useEffect(() => {
    if (Page) send({ type: "ready" });
    else {
      fail({
        type: "failed",
        reason: "files",
        message: `No page ${shown.page}`,
      });
    }
    // Said once for each page shown.
  }, [Page, send, fail, shown.page, shown.generation]);
  if (!Page) return null;
  const Provider = ui.Provider ?? Passing;
  return (
    <AppScope client={client}>
      <TemperatureUnitProvider
        unit={shown.context.temperatureUnit ?? undefined}
      >
        <HomeTimeZoneProvider timeZone={shown.context.timeZone ?? undefined}>
          <PageBarSink.Provider value={sayBar}>
            <Provider>
              <main className="frame-page">
                <Page
                  key={`${shown.page}:${shown.generation}`}
                  params={shown.params}
                  open={(page, params = {}) =>
                    send({ type: "open", page, params })
                  }
                  back={() => send({ type: "back" })}
                  openSettings={() => send({ type: "openSettings" })}
                />
              </main>
            </Provider>
          </PageBarSink.Provider>
        </HomeTimeZoneProvider>
      </TemperatureUnitProvider>
    </AppScope>
  );
}

const Passing = (props: { children: ReactNode }) => <>{props.children}</>;

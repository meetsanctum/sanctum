import type { AppInfo, DeviceInfo } from "@meetsanctum/app-sdk";
import { StrictMode, useEffect, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { AppScope, type AppUi, type PageParams } from "../app-ui";
import { deviceKindsOf, type AppClient, type LiveListener } from "../client";
import type { PressCaptureListener } from "../presses";
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
  // For a device page, the device it shows.
  device?: DeviceInfo;
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
  // The captures the page began and hasn't stopped, by their number.
  const captures = new Map<number, PressCaptureListener>();
  let nextCapture = 0;
  let nextId = 0;
  let ui: AppUi | undefined;
  let shown: Shown | undefined;
  let client: AppClient | undefined;
  let root: Root | undefined;
  // The top bar as last said to the shell, and its actions' handlers, the
  // latest ones: a press of what the shell drew at an older revision is
  // dropped.
  let bar = { said: "", revision: 0 };
  let presses = new Map<string, () => void>();
  const sayBar = (title: string, actions: readonly PageBarAction[]) => {
    presses = new Map(
      actions
        .filter((action) => !action.disabled)
        .map((action) => [action.id, action.onPress]),
    );
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
    presses.clear();
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
  const clientOf = (app: AppInfo): AppClient => {
    let permissions = [...app.permissions];
    return {
      app,
      call: (actionId, input) => request({ op: "call", actionId, input }),
      places: () => request({ op: "places" }),
      devices: () => request({ op: "devices" }),
      command: (command) => request({ op: "command", command }),
      entities: () => request({ op: "entities" }),
      settings: () => request({ op: "settings" }),
      async ask(requested) {
        const ids =
          typeof requested === "string" ? [requested] : [...requested];
        const granted = await request<boolean>({ op: "ask", permissions: ids });
        if (granted) permissions = [...permissions, ...ids];
        return granted;
      },
      // The shell runs the capture through its client for the app, which
      // refuses one the app may not read buttons for, as the page is told
      // here first.
      capturePresses(device, listener) {
        if (!deviceKindsOf(permissions).reads.has("button")) {
          throw new Error(`${app.id} does not hold devices.read:button`);
        }
        const capture = ++nextCapture;
        captures.set(capture, listener);
        send({ type: "capture", capture, device });
        return {
          stop() {
            captures.delete(capture);
            return request<void>({ op: "release", capture });
          },
        };
      },
      subscribe(listener) {
        listeners.add(listener);
        if (listeners.size === 1) send({ type: "subscribe", on: true });
        return () => {
          if (!listeners.delete(listener)) return;
          if (listeners.size === 0) send({ type: "subscribe", on: false });
        };
      },
    };
  };

  // How tall the page is drawn, said as it changes, for a device page's
  // frame to fit it.
  let height = -1;
  // The page's own height, not the document's, which is at least the
  // frame's and so could never shrink it.
  const sizes = new ResizeObserver(([entry]) => {
    if (!entry) return;
    const next = Math.ceil(entry.target.getBoundingClientRect().height);
    if (next === height) return;
    height = next;
    send({ type: "size", height });
  });
  // An Escape the page didn't use goes to the shell, which may close what
  // the frame is in: a key pressed in the frame never reaches it. Whether
  // the page used it is known once every listener has had it, its own on
  // the window too, which this one, added first, would run before.
  window.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    setTimeout(() => {
      if (!event.defaultPrevented) send({ type: "key", key: "Escape" });
    });
  });

  // A shell from before Reduce motion reached pages doesn't say it, and the
  // page follows the system's reduced motion itself.
  const systemMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  const setMotion = (motion: FrameContext["motion"]) => {
    const { dataset } = document.documentElement;
    const reduced =
      motion === undefined ? systemMotion?.matches : motion === "reduced";
    if (reduced) {
      dataset.motion = "reduced";
    } else {
      delete dataset.motion;
    }
  };
  systemMotion?.addEventListener("change", () => {
    if (root && !hasFailed && shown?.context.motion === undefined) {
      setMotion(undefined);
    }
  });

  const draw = () => {
    if (!ui || !shown || hasFailed) return;
    // Device and context updates keep the client's identity, so effects
    // that load app data don't run again for unrelated page updates.
    if (!client || client.app !== shown.app) client = clientOf(shown.app);
    const { dataset } = document.documentElement;
    dataset.mode = shown.context.mode;
    if (shown.context.effects === "reduced") dataset.effects = "reduced";
    else delete dataset.effects;
    setMotion(shown.context.motion);
    // A device page lies over the device's detail, which shows through.
    if (shown.device) dataset.surface = "detail";
    if (!root) {
      const holder = document.body.appendChild(document.createElement("div"));
      sizes.observe(holder);
      root = createRoot(holder, {
        onUncaughtError: (error) =>
          fail({ type: "failed", reason: "stopped", message: String(error) }),
      });
    }
    root.render(
      <StrictMode>
        <Framed
          ui={ui}
          shown={shown}
          client={client}
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
          ...(message.device ? { device: message.device } : {}),
          generation: 0,
        };
        return draw();
      case "device":
        if (shown?.device) shown = { ...shown, device: message.device };
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
        presses.clear();
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
      case "captured":
        captures.get(message.capture)?.press(message.press);
        return;
      case "captureEnded": {
        const listener = captures.get(message.capture);
        captures.delete(message.capture);
        listener?.ended?.(message.reason);
        return;
      }
      case "press":
        // A press can disable its action: commit that before the next
        // queued press, as React does for a button's own click.
        flushSync(() => {
          if (message.revision === bar.revision) presses.get(message.id)?.();
        });
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
  const { device } = shown;
  const DevicePage = device ? ui.devicePages?.[shown.page] : undefined;
  const AppPage = device ? undefined : ui.pages[shown.page];
  const Page = DevicePage ?? AppPage;
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
              {DevicePage && device ? (
                <main className="frame-device">
                  <DevicePage device={device} />
                </main>
              ) : AppPage ? (
                <main className="frame-page">
                  <AppPage
                    key={`${shown.page}:${shown.generation}`}
                    params={shown.params}
                    open={(page, params = {}) =>
                      send({ type: "open", page, params })
                    }
                    back={() => send({ type: "back" })}
                    openSettings={() => send({ type: "openSettings" })}
                  />
                </main>
              ) : null}
            </Provider>
          </PageBarSink.Provider>
        </HomeTimeZoneProvider>
      </TemperatureUnitProvider>
    </AppScope>
  );
}

const Passing = (props: { children: ReactNode }) => <>{props.children}</>;

import type { AppInfo, EntityInfo } from "@meetsanctum/app-sdk";
import {
  createAppClient,
  createLiveFeed,
  frameBridge,
  startFrame,
  type AppUi,
  type CoreBridge,
  type FrameContext,
  type ToFrame,
} from "@meetsanctum/ui-sdk";
import { afterEach, beforeEach, vi, expect, type Mock } from "vitest";
import {
  openBridge,
  type FrameBridge,
  type FrameEvent,
} from "../src/frames/bridge";

// An app's page in its frame and the shell's end of it, over a real message
// channel. jsdom has one window, so it stands for the frame, whose parent it
// is too; the shell listens on a target of its own, and the frame's window
// as the shell sees it hands what it's sent to this one.

export const info: AppInfo = {
  id: "sanctum.example",
  name: "Example",
  version: "0.1.0",
  icon: null,
  pages: ["main", "day"],
  permissions: [],
  requests: [],
  state: "running",
  settings: null,
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
};

const forecast: EntityInfo = {
  app: "sanctum.example",
  key: "forecast-1",
  type: "sanctum.example.forecast",
  name: "Forecast",
  state: {},
  updatedAt: "2026-11-16T12:00:00.000Z",
};

export const context = {
  mode: "day" as const,
  temperatureUnit: null,
  timeZone: null,
};

export let live: ReturnType<typeof createLiveFeed>;
export let json: Mock<(path: string, init?: unknown) => Promise<unknown>>;
export let shell: EventTarget;
export let opened: FrameBridge[];

// jsdom measures nothing: a page's size is whatever a test says, through
// the observer the frame watches its page with.
export let resized: (height: number) => void = () => {};
class Sizes {
  constructor(private readonly said: ResizeObserverCallback) {}
  observe(target: Element) {
    resized = (height) => {
      target.getBoundingClientRect = () => ({ height }) as DOMRect;
      this.said([{ target } as ResizeObserverEntry], this as never);
    };
  }
  disconnect() {}
  unobserve() {}
}

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", Sizes);
  live = createLiveFeed();
  json = vi.fn(async (path: string): Promise<unknown> => {
    if (path === "/api/entities") return [forecast];
    throw Object.assign(new Error("No such thing"), { code: "not_found" });
  });
  shell = new EventTarget();
  opened = [];
  location.hash = "#hello=code-1";
});

afterEach(() => {
  for (const bridge of opened) bridge.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
  delete document.documentElement.dataset.effects;
});

export const client = (app = info) =>
  createAppClient(app, {
    json: json as unknown as CoreBridge["json"],
    live,
    ask: vi.fn(async () => true),
  });

export const message = (data: unknown, more: object) =>
  Object.assign(new Event("message"), { data, ...more });

// The shell's end, for the frame whose window is `frame`.
export function shellEnd(
  frame: Window,
  code = "code-1",
  app = info,
  frameContext: FrameContext = context,
) {
  const events: FrameEvent[] = [];
  let appClient = client(app);
  const bridge = openBridge({
    frame: () => frame,
    code,
    client: () => appClient,
    setup: () => ({
      type: "setup",
      app,
      page: "main",
      params: {},
      context: frameContext,
    }),
    on: (event) => events.push(event),
    host: shell as unknown as Window,
  });
  opened.push(bridge);
  return {
    bridge,
    events,
    renew(next: AppInfo) {
      app = next;
      appClient = client(app);
      bridge.send({ type: "app", app });
      bridge.renew();
    },
  };
}

// The frame's window as the shell sees it, which passes on what it's sent.
export function frameWindow(
  take: (data: unknown, ports: MessagePort[]) => void,
) {
  return {
    postMessage: vi.fn((data: unknown, _to: string, ports: MessagePort[]) =>
      take(data, ports),
    ),
  } as unknown as Window & { postMessage: ReturnType<typeof vi.fn> };
}

// A page in its frame, started by the kit as the core's entry starts it.
export function framed(
  ui: () => Promise<{ default: AppUi }>,
  app = info,
  frameContext: FrameContext = context,
) {
  const frame = frameWindow((data, ports) =>
    window.dispatchEvent(message(data, { source: window, ports })),
  );
  vi.spyOn(window, "postMessage").mockImplementation((data: unknown) => {
    shell.dispatchEvent(message(data, { source: frame }));
  });
  const end = shellEnd(frame, "code-1", app, frameContext);
  startFrame(ui);
  return { ...end, frame };
}

// The frame's end of the port, as a page's own code could use it.
export let shellEvents: FrameEvent[] = [];
export async function framePort(app = info) {
  let given: MessagePort | undefined;
  const frame = frameWindow((_data, ports) => (given = ports[0]));
  const end = shellEnd(frame, "code-1", app);
  shellEvents = end.events;
  shell.dispatchEvent(
    message(
      { sanctum: "hello", code: "code-1", bridge: frameBridge },
      { source: frame },
    ),
  );
  const answers: ToFrame[] = [];
  given!.onmessage = (event: MessageEvent<ToFrame>) => answers.push(event.data);
  await vi.waitFor(() => expect(answers[0]?.type).toBe("setup"));
  return { port: given!, answers, bridge: end.bridge, renew: end.renew };
}

export const answerTo = (answers: ToFrame[], id: number) =>
  answers.find((each) => each.type === "answer" && each.id === id);

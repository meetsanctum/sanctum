// @vitest-environment jsdom
import type { AppInfo, DeviceInfo, EntityInfo } from "@meetsanctum/app-sdk";
import {
  createAppClient,
  createLiveFeed,
  frameBridge,
  PageBar,
  startFrame,
  useAppClient,
  type AppUi,
  type CoreBridge,
  type DevicePageProps,
  type PageProps,
  type ToFrame,
} from "@meetsanctum/ui-sdk";
import { useEffect, useRef, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  capturesAllowed,
  openBridge,
  requestsAllowed,
  tallest,
  type FrameBridge,
  type FrameEvent,
} from "../src/frames/bridge";

// An app's page in its frame and the shell's end of it, over a real message
// channel. jsdom has one window, so it stands for the frame, whose parent it
// is too; the shell listens on a target of its own, and the frame's window
// as the shell sees it hands what it's sent to this one.

const info: AppInfo = {
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

const context = { mode: "day" as const, temperatureUnit: null, timeZone: null };

let live: ReturnType<typeof createLiveFeed>;
let json: ReturnType<typeof vi.fn>;
let shell: EventTarget;
let opened: FrameBridge[];

// jsdom measures nothing: a page's size is whatever a test says, through
// the observer the frame watches its page with.
let resized: (height: number) => void = () => {};
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
  json = vi.fn(async (path: string) => {
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
});

const client = (app = info) =>
  createAppClient(app, {
    json: json as unknown as CoreBridge["json"],
    live,
    ask: vi.fn(async () => true),
  });

const message = (data: unknown, more: object) =>
  Object.assign(new Event("message"), { data, ...more });

// The shell's end, for the frame whose window is `frame`.
function shellEnd(frame: Window, code = "code-1", app = info) {
  const events: FrameEvent[] = [];
  const bridge = openBridge({
    frame: () => frame,
    code,
    client: () => client(app),
    setup: () => ({
      type: "setup",
      app,
      page: "main",
      params: {},
      context,
    }),
    on: (event) => events.push(event),
    host: shell as unknown as Window,
  });
  opened.push(bridge);
  return { bridge, events };
}

// The frame's window as the shell sees it, which passes on what it's sent.
function frameWindow(take: (data: unknown, ports: MessagePort[]) => void) {
  return {
    postMessage: vi.fn((data: unknown, _to: string, ports: MessagePort[]) =>
      take(data, ports),
    ),
  } as unknown as Window & { postMessage: ReturnType<typeof vi.fn> };
}

// A page in its frame, started by the kit as the core's entry starts it.
function framed(ui: () => Promise<{ default: AppUi }>, app = info) {
  const frame = frameWindow((data, ports) =>
    window.dispatchEvent(message(data, { source: window, ports })),
  );
  vi.spyOn(window, "postMessage").mockImplementation((data: unknown) => {
    shell.dispatchEvent(message(data, { source: frame }));
  });
  const end = shellEnd(frame, "code-1", app);
  startFrame(ui);
  return { ...end, frame };
}

function Main(props: PageProps) {
  const client = useAppClient();
  const [entities, setEntities] = useState("none");
  const [refreshes, setRefreshes] = useState(0);
  useEffect(() => {
    void client
      .entities()
      .then((list) => setEntities(list.map((each) => each.key).join(",")));
    return client.subscribe({ refresh: () => setRefreshes((n) => n + 1) });
  }, [client]);
  return (
    <>
      <PageBar title="Forecast" />
      <p>entities {entities}</p>
      <p>refreshed {refreshes}</p>
      <button onClick={() => props.open("day", { date: "2026-11-16" })}>
        Day
      </button>
    </>
  );
}

const ui: AppUi = { id: info.id, version: info.version, pages: { main: Main } };

// The app as one that reads remotes' buttons, and the core's answer to a
// capture's start, a new one each time.
const readsButtons: AppInfo = { ...info, permissions: ["devices.read:button"] };
function capturesStart() {
  let started = 0;
  json.mockImplementation(async (path: string) =>
    path === "/api/devices/capture/start"
      ? {
          id: `capture-${++started}`,
          device: "remote-1",
          until: new Date(Date.now() + 60_000).toISOString(),
        }
      : undefined,
  );
}
const callsTo = (path: string) =>
  json.mock.calls.filter(([called]) => called === path);

describe("a page in its frame", () => {
  it("is drawn with what the shell's client for its app answers", async () => {
    const { events } = framed(async () => ({ default: ui }));
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("entities forecast-1"),
    );
    // Asked as the app, which the core answers with what it may see.
    expect(json).toHaveBeenCalledWith("/api/entities", { app: info.id });
    expect(events).toContainEqual({ type: "ready" });
    expect(events).toContainEqual({
      type: "bar",
      title: "Forecast",
      actions: [],
      revision: 1,
    });
    // Its title is the shell's to show; the frame draws none.
    expect(document.querySelector("h1")).toBeNull();
    expect(document.documentElement.dataset.mode).toBe("day");
  });

  it("hears the shell's live updates while it listens, and none once closed", async () => {
    const { bridge } = framed(async () => ({ default: ui }));
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("entities forecast-1"),
    );
    live.refresh();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("refreshed 1"),
    );
    bridge.close();
    live.refresh();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(document.body.textContent).toContain("refreshed 1");
  });

  it("asks the shell to open another of its pages", async () => {
    const { events } = framed(async () => ({ default: ui }));
    await vi.waitFor(() =>
      expect(document.querySelector("button")).not.toBeNull(),
    );
    document.querySelector("button")!.click();
    await vi.waitFor(() =>
      expect(events).toContainEqual({
        type: "open",
        page: "day",
        params: { date: "2026-11-16" },
      }),
    );
  });

  it("describes its top bar's actions, and acts on a press of what the shell drew", async () => {
    let saves = 0;
    function Editor() {
      const [busy, setBusy] = useState(false);
      return (
        <>
          <PageBar
            title="Edit mood"
            actions={[
              { id: "cancel", label: "Cancel", onPress: () => setBusy(true) },
              {
                id: "save",
                label: "Save",
                primary: true,
                disabled: busy,
                onPress: () => (saves += 1),
              },
            ]}
          />
          <p>busy {String(busy)}</p>
        </>
      );
    }
    const { bridge, events } = framed(async () => ({
      default: { ...ui, pages: { main: Editor } },
    }));
    const bars = () =>
      events.filter(
        (event): event is Extract<FrameEvent, { type: "bar" }> =>
          event.type === "bar",
      );
    await vi.waitFor(() => expect(bars()).toHaveLength(1));
    expect(bars()[0]).toEqual({
      type: "bar",
      title: "Edit mood",
      actions: [
        { id: "cancel", label: "Cancel" },
        { id: "save", label: "Save", primary: true },
      ],
      revision: 1,
    });
    bridge.send({ type: "press", id: "save", revision: 1 });
    await vi.waitFor(() => expect(saves).toBe(1));
    // Cancel dims Save: a new revision, and a press of the old one is dropped.
    bridge.send({ type: "press", id: "cancel", revision: 1 });
    await vi.waitFor(() => expect(bars()).toHaveLength(2));
    expect(bars()[1]!.revision).toBe(2);
    expect(bars()[1]!.actions[1]).toEqual({
      id: "save",
      label: "Save",
      primary: true,
      disabled: true,
    });
    bridge.send({ type: "press", id: "save", revision: 1 });
    bridge.send({ type: "press", id: "save", revision: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(saves).toBe(1);
  });

  it("dims a busy action before handling another queued press", async () => {
    const save = vi.fn();
    function Editor() {
      const [isBusy, setIsBusy] = useState(false);
      return (
        <PageBar
          title="Edit mood"
          actions={[
            {
              id: "save",
              label: "Save",
              disabled: isBusy,
              onPress: () => {
                save();
                setIsBusy(true);
              },
            },
          ]}
        />
      );
    }
    const { bridge, events } = framed(async () => ({
      default: { ...ui, pages: { main: Editor } },
    }));
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ type: "bar" })),
    );
    bridge.send({ type: "press", id: "save", revision: 1 });
    bridge.send({ type: "press", id: "save", revision: 1 });
    await vi.waitFor(() =>
      expect(events).toContainEqual(
        expect.objectContaining({ type: "bar", revision: 2 }),
      ),
    );
    expect(save).toHaveBeenCalledOnce();
  });

  it("forgets the previous page's actions while the next page has no bar", async () => {
    const save = vi.fn();
    function Editor() {
      return (
        <PageBar
          title="Edit mood"
          actions={[{ id: "save", label: "Save", onPress: save }]}
        />
      );
    }
    const { bridge, events } = framed(async () => ({
      default: {
        ...ui,
        pages: { main: Editor, day: () => <p>Loading the next page</p> },
      },
    }));
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ type: "bar" })),
    );
    bridge.send({ type: "show", page: "day", params: {} });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("Loading the next page"),
    );
    bridge.send({ type: "press", id: "save", revision: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(save).not.toHaveBeenCalled();
  });

  it("forgets the actions of a page that stops working", async () => {
    const save = vi.fn();
    function Editor() {
      const [isBroken, setIsBroken] = useState(false);
      if (isBroken) throw new Error("Broken editor");
      return (
        <>
          <PageBar
            title="Edit mood"
            actions={[{ id: "save", label: "Save", onPress: save }]}
          />
          <button onClick={() => setIsBroken(true)}>Break the editor</button>
        </>
      );
    }
    const { bridge, events } = framed(async () => ({
      default: { ...ui, pages: { main: Editor } },
    }));
    await vi.waitFor(() =>
      expect(events).toContainEqual(expect.objectContaining({ type: "bar" })),
    );
    document.querySelector("button")!.click();
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: "failed", reason: "stopped" }),
    );
    bridge.send({ type: "press", id: "save", revision: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(save).not.toHaveBeenCalled();
  });

  it("shows a device page with its device, as it changes, and says its height", async () => {
    const device = {
      id: "remote-1",
      name: "Office button",
    } as unknown as DeviceInfo;
    function Presses(props: DevicePageProps) {
      const client = useAppClient();
      const [entities, setEntities] = useState("none");
      useEffect(() => {
        void client.entities().then((list) => {
          setEntities(list.map((each) => each.key).join(","));
        });
      }, [client]);
      return (
        <>
          <p>device {props.device.name}</p>
          <p>entities {entities}</p>
          <p>permissions {client.app.permissions.join(",")}</p>
        </>
      );
    }
    const frame = frameWindow((data, ports) =>
      window.dispatchEvent(message(data, { source: window, ports })),
    );
    vi.spyOn(window, "postMessage").mockImplementation((data: unknown) => {
      shell.dispatchEvent(message(data, { source: frame }));
    });
    const events: FrameEvent[] = [];
    const bridge = openBridge({
      frame: () => frame,
      code: "code-1",
      client,
      setup: () => ({
        type: "setup",
        app: info,
        page: "example.presses",
        params: {},
        context,
        device,
      }),
      on: (event) => events.push(event),
      host: shell as unknown as Window,
    });
    opened.push(bridge);
    startFrame(async () => ({
      default: { ...ui, devicePages: { "example.presses": Presses } },
    }));
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("device Office button"),
    );
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("entities forecast-1"),
    );
    const reads = json.mock.calls.length;
    expect(document.documentElement.dataset.surface).toBe("detail");
    bridge.send({ type: "device", device: { ...device, name: "Desk button" } });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("device Desk button"),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(json).toHaveBeenCalledTimes(reads);
    bridge.send({
      type: "app",
      app: { ...info, permissions: ["devices.read:button"] },
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        "permissions devices.read:button",
      ),
    );
    await vi.waitFor(() => expect(json).toHaveBeenCalledTimes(reads + 1));
    resized(321);
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: "size", height: 321 }),
    );
    // An Escape the page leaves goes to the shell; one it uses doesn't.
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: "key", key: "Escape" }),
    );
    const used = new KeyboardEvent("keydown", {
      key: "Escape",
      cancelable: true,
    });
    used.preventDefault();
    window.dispatchEvent(used);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.filter((event) => event.type === "key")).toHaveLength(1);
    delete document.documentElement.dataset.surface;
  });

  it("captures a remote's presses through the shell's client for its app", async () => {
    capturesStart();
    function Find() {
      const client = useAppClient();
      const [heard, setHeard] = useState("nothing");
      const capture = useRef<{ stop(): Promise<void> }>(null);
      return (
        <>
          <p>heard {heard}</p>
          <button
            onClick={() => {
              capture.current = client.capturePresses("remote-1", {
                press: (press) => setHeard(press.action),
              });
            }}
          >
            Find
          </button>
          <button onClick={() => void capture.current?.stop()}>Stop</button>
        </>
      );
    }
    framed(
      async () => ({ default: { ...ui, pages: { main: Find } } }),
      readsButtons,
    );
    const button = (name: string) =>
      [...document.querySelectorAll("button")].find(
        (each) => each.textContent === name,
      );
    await vi.waitFor(() => expect(button("Find")).toBeDefined());

    button("Find")!.click();
    await vi.waitFor(() =>
      expect(callsTo("/api/devices/capture/start")).toEqual([
        [
          "/api/devices/capture/start",
          {
            method: "POST",
            json: { device: "remote-1", app: info.id },
            app: info.id,
          },
        ],
      ]),
    );
    live.publish({
      type: "press",
      device: "remote-1",
      capability: "button",
      action: "double",
      at: new Date().toISOString(),
      isCaptured: true,
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain("heard double"),
    );

    button("Stop")!.click();
    await vi.waitFor(() =>
      expect(callsTo("/api/devices/capture/stop")).toEqual([
        [
          "/api/devices/capture/stop",
          { method: "POST", json: { id: "capture-1" }, app: info.id },
        ],
      ]),
    );
  });

  it("refuses a capture its app may not read buttons for, as the shell would", async () => {
    let refused: unknown;
    function Find() {
      const client = useAppClient();
      useEffect(() => {
        try {
          client.capturePresses("remote-1", { press: () => {} });
        } catch (error) {
          refused = error;
        }
      }, [client]);
      return <p>finding</p>;
    }
    framed(async () => ({ default: { ...ui, pages: { main: Find } } }));
    await vi.waitFor(() =>
      expect(String(refused)).toContain(
        "sanctum.example does not hold devices.read:button",
      ),
    );
  });

  it("says its files didn't load", async () => {
    const { events } = framed(async () => {
      throw new TypeError("Failed to fetch dynamically imported module");
    });
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: "failed", reason: "files" }),
    );
  });

  it("says it stopped working when React gives up on it", async () => {
    const Broken = () => {
      throw new Error("Broken page");
    };
    const { events } = framed(async () => ({
      default: { ...ui, pages: { main: Broken } },
    }));
    await vi.waitFor(() =>
      expect(events).toContainEqual({ type: "failed", reason: "stopped" }),
    );
    expect(events).not.toContainEqual({ type: "ready" });
  });
});

describe("the shell's end", () => {
  it("answers only its frame's window, with the code in its address", () => {
    const frame = frameWindow(() => {});
    shellEnd(frame);
    const hello = { sanctum: "hello", code: "code-1", bridge: frameBridge };
    shell.dispatchEvent(message(hello, { source: window }));
    shell.dispatchEvent(
      message({ ...hello, code: "code-2" }, { source: frame }),
    );
    expect(frame.postMessage).not.toHaveBeenCalled();
    shell.dispatchEvent(message(hello, { source: frame }));
    expect(frame.postMessage).toHaveBeenCalledOnce();
    // A second hello gets no second port.
    shell.dispatchEvent(message(hello, { source: frame }));
    expect(frame.postMessage).toHaveBeenCalledOnce();
  });

  it.each([1, frameBridge + 1])(
    "can't be opened by a page of bridge %i",
    (bridge) => {
      const frame = frameWindow(() => {});
      const { events } = shellEnd(frame);
      shell.dispatchEvent(
        message(
          { sanctum: "hello", code: "code-1", bridge },
          { source: frame },
        ),
      );
      expect(frame.postMessage).not.toHaveBeenCalled();
      expect(events).toEqual([{ type: "failed", reason: "files" }]);
    },
  );

  // The frame's end of the port, as a page's own code could use it.
  let shellEvents: FrameEvent[] = [];
  async function framePort(app = info) {
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
    given!.onmessage = (event: MessageEvent<ToFrame>) =>
      answers.push(event.data);
    await vi.waitFor(() => expect(answers[0]?.type).toBe("setup"));
    return { port: given!, answers, bridge: end.bridge };
  }

  const answerTo = (answers: ToFrame[], id: number) =>
    answers.find((each) => each.type === "answer" && each.id === id);

  it("runs only AppClient's operations, through the app's client", async () => {
    const { port, answers } = await framePort();
    port.postMessage({ type: "request", id: 1, op: "fetch", url: "/api/x" });
    port.postMessage({ type: "request", id: 2, op: "call", actionId: 7 });
    port.postMessage({ type: "request", id: 3, op: "places" });
    port.postMessage({ type: "request", id: 4, op: "settings" });
    await vi.waitFor(() => expect(answerTo(answers, 4)).toBeDefined());
    expect(answerTo(answers, 1)).toMatchObject({ ok: false });
    expect(answerTo(answers, 2)).toMatchObject({ ok: false });
    // The client refuses what the app doesn't hold, before the core.
    expect(answerTo(answers, 3)).toMatchObject({
      ok: false,
      error: { message: "sanctum.example does not hold places.read" },
    });
    // And says what the core refused with, its code too.
    expect(answerTo(answers, 4)).toEqual({
      type: "answer",
      id: 4,
      ok: false,
      error: { message: "No such thing", code: "not_found" },
    });
    expect(json).toHaveBeenCalledOnce();
    expect(json).toHaveBeenCalledWith("/api/apps/sanctum.example/settings", {
      app: info.id,
    });
  });

  it("draws no top bar a page describes beyond what it may", async () => {
    const { port } = await framePort();
    const bar = (actions: unknown) =>
      port.postMessage({ type: "bar", title: "Edit", actions, revision: 1 });
    // Four actions, two primaries, or the same id twice.
    bar([1, 2, 3, 4].map((n) => ({ id: `a${n}`, label: "A" })));
    bar([
      { id: "a", label: "A", primary: true },
      { id: "b", label: "B", primary: true },
    ]);
    bar([
      { id: "a", label: "A" },
      { id: "a", label: "B" },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(shellEvents.filter((event) => event.type === "bar")).toEqual([]);
  });

  it("believes no height but a whole one up to its limit, and no key but Escape", async () => {
    const { port } = await framePort();
    for (const height of [-1, 1.5, tallest + 1, "10"]) {
      port.postMessage({ type: "size", height });
    }
    port.postMessage({ type: "key", key: "Enter" });
    port.postMessage({ type: "size", height: 400 });
    await vi.waitFor(() =>
      expect(shellEvents).toContainEqual({ type: "size", height: 400 }),
    );
    expect(
      shellEvents.filter(
        (event) => event.type === "size" || event.type === "key",
      ),
    ).toEqual([{ type: "size", height: 400 }]);
  });

  it("refuses more than so many waiting at once", async () => {
    json.mockImplementation(() => new Promise(() => {}));
    const { port, answers } = await framePort();
    for (let id = 1; id <= requestsAllowed + 1; id++) {
      port.postMessage({ type: "request", id, op: "entities" });
    }
    await vi.waitFor(() =>
      expect(answerTo(answers, requestsAllowed + 1)).toMatchObject({
        ok: false,
        error: { code: "busy" },
      }),
    );
    expect(answers.filter((each) => each.type === "answer")).toHaveLength(1);
  });

  it("ends a capture its app can't have at once, holds so many, and ends them with the frame", async () => {
    capturesStart();
    const ended = (capture: number) => ({
      type: "captureEnded",
      capture,
      reason: "failed",
    });
    const blind = await framePort();
    blind.port.postMessage({ type: "capture", capture: 1, device: "remote-1" });
    await vi.waitFor(() => expect(blind.answers).toContainEqual(ended(1)));
    expect(json).not.toHaveBeenCalled();

    const { port, answers, bridge } = await framePort(readsButtons);
    for (let capture = 1; capture <= capturesAllowed + 1; capture++) {
      port.postMessage({ type: "capture", capture, device: "remote-1" });
    }
    await vi.waitFor(() =>
      expect(answers).toContainEqual(ended(capturesAllowed + 1)),
    );
    await vi.waitFor(() =>
      expect(callsTo("/api/devices/capture/start")).toHaveLength(
        capturesAllowed,
      ),
    );
    expect(answers.filter((each) => each.type === "captureEnded")).toEqual([
      ended(capturesAllowed + 1),
    ]);

    // What the page held back reaches workflows again once it's gone.
    bridge.close();
    await vi.waitFor(() =>
      expect(callsTo("/api/devices/capture/stop")).toHaveLength(
        capturesAllowed,
      ),
    );
  });
});

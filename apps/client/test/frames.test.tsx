// @vitest-environment jsdom
import type { DeviceInfo } from "@meetsanctum/app-sdk";
import {
  frameBridge,
  Input,
  PageBar,
  startFrame,
  useAppClient,
  useReducedEffects,
  useReducedMotion,
  type AppUi,
  type DevicePageProps,
  type PageProps,
} from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  openBridge,
  requestsAllowed,
  tallest,
  type FrameEvent,
} from "../src/frames/bridge";
import {
  info,
  context,
  live,
  json,
  shell,
  opened,
  resized,
  client,
  message,
  shellEnd,
  frameWindow,
  framed,
  framePort,
  shellEvents,
  answerTo,
} from "./frames-support";

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

  it("applies Reduce effects to a framed input on setup and context updates", async () => {
    function Editor() {
      const reduced = useReducedEffects();
      return <Input aria-label="Name" data-reduced={reduced} />;
    }
    const { bridge } = framed(
      async () => ({ default: { ...ui, pages: { main: Editor } } }),
      info,
      { ...context, effects: "reduced" },
    );
    const input = () => document.querySelector('input[aria-label="Name"]');
    const reducedShadow = String.raw`.reduce-effects\:shadow-none:where([data-effects="reduced"], [data-effects="reduced"] *)`;

    await vi.waitFor(() => {
      expect(input()?.matches(reducedShadow)).toBe(true);
      expect(input()?.getAttribute("data-reduced")).toBe("true");
    });
    bridge.send({
      type: "context",
      context: { ...context, effects: "regular" },
    });
    await vi.waitFor(() => {
      expect(input()?.matches(reducedShadow)).toBe(false);
      expect(input()?.getAttribute("data-reduced")).toBe("false");
    });
    bridge.send({
      type: "context",
      context: { ...context, effects: "reduced" },
    });
    await vi.waitFor(() => expect(input()?.matches(reducedShadow)).toBe(true));
    bridge.send({ type: "context", context });
    await vi.waitFor(() => expect(input()?.matches(reducedShadow)).toBe(false));
  });

  it("applies Reduce motion from the shell, or the system's where the shell doesn't say", async () => {
    const systemMotion = Object.assign(new EventTarget(), { matches: false });
    vi.stubGlobal("matchMedia", (media: string) => {
      expect(media).toBe("(prefers-reduced-motion: reduce)");
      return systemMotion;
    });
    function Moving() {
      const reduced = useReducedMotion();
      return <p data-reduced={reduced}>moving</p>;
    }
    const { bridge } = framed(
      async () => ({ default: { ...ui, pages: { main: Moving } } }),
      info,
      { ...context, motion: "reduced" },
    );
    const shown = () => document.querySelector("p[data-reduced]");
    await vi.waitFor(() =>
      expect(shown()?.getAttribute("data-reduced")).toBe("true"),
    );
    bridge.send({
      type: "context",
      context: { ...context, motion: "regular" },
    });
    await vi.waitFor(() =>
      expect(shown()?.getAttribute("data-reduced")).toBe("false"),
    );
    // A shell that doesn't say leaves it to the system's setting.
    systemMotion.matches = true;
    systemMotion.dispatchEvent(new Event("change"));
    bridge.send({ type: "context", context });
    await vi.waitFor(() =>
      expect(shown()?.getAttribute("data-reduced")).toBe("true"),
    );
    systemMotion.matches = false;
    systemMotion.dispatchEvent(new Event("change"));
    await vi.waitFor(() =>
      expect(shown()?.getAttribute("data-reduced")).toBe("false"),
    );
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
    // One the page uses in a listener of its own on the window, which runs
    // after the kit's, doesn't either.
    const own = (event: KeyboardEvent) => event.preventDefault();
    window.addEventListener("keydown", own);
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
    );
    window.removeEventListener("keydown", own);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(events.filter((event) => event.type === "key")).toHaveLength(1);
    delete document.documentElement.dataset.surface;
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
});

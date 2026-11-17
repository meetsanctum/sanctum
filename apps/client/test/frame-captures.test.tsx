// @vitest-environment jsdom
import type { AppInfo } from "@meetsanctum/app-sdk";
import { useAppClient, type AppUi, type AppClient } from "@meetsanctum/ui-sdk";
import { useEffect, useRef, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { capturesAllowed } from "../src/frames/bridge";
import {
  info,
  json,
  live,
  framed,
  framePort,
  answerTo,
} from "./frames-support";

const ui: AppUi = { id: info.id, version: info.version, pages: {} };

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

describe("a frame capturing a remote's presses", () => {
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

  it("can capture immediately after its ask grants button access", async () => {
    capturesStart();
    const app: AppInfo = {
      ...info,
      requests: [
        {
          id: "devices.read:button",
          reason: "Find a press",
          needed: false,
          asked: null,
          startsOn: false,
        },
      ],
    };
    let pageClient: AppClient | undefined;
    function Find() {
      pageClient = useAppClient();
      return <p>Find a press</p>;
    }
    framed(async () => ({ default: { ...ui, pages: { main: Find } } }), app);
    await vi.waitFor(() => expect(pageClient).toBeDefined());
    expect(await pageClient!.ask("devices.read:button")).toBe(true);
    const capture = pageClient!.capturePresses("remote-1", { press: vi.fn() });
    await vi.waitFor(() =>
      expect(callsTo("/api/devices/capture/start")).toHaveLength(1),
    );
    await capture.stop();
  });

  it("lets an ended capture retry a failed release", async () => {
    capturesStart();
    const starting = json.getMockImplementation()!;
    json.mockImplementation(async (path: string) => {
      if (path === "/api/devices/capture/stop") throw new Error("offline");
      return starting(path);
    });
    let pageClient: AppClient | undefined;
    function Find() {
      pageClient = useAppClient();
      return <p>Find a press</p>;
    }
    framed(
      async () => ({ default: { ...ui, pages: { main: Find } } }),
      readsButtons,
    );
    await vi.waitFor(() => expect(pageClient).toBeDefined());
    const ended = vi.fn();
    const capture = pageClient!.capturePresses("remote-1", {
      press: vi.fn(),
      ended,
    });
    await vi.waitFor(() =>
      expect(callsTo("/api/devices/capture/start")).toHaveLength(1),
    );
    live.publish({
      type: "press",
      device: "remote-1",
      capability: "button",
      action: "single",
      at: new Date().toISOString(),
      isCaptured: false,
    });
    await vi.waitFor(() => expect(ended).toHaveBeenCalledWith("failed"));
    await expect(capture.stop()).rejects.toThrow("offline");
    json.mockImplementation(starting);
    await capture.stop();
    expect(callsTo("/api/devices/capture/stop")).toHaveLength(4);
  });

  it("keeps a late start within the capture limit until its release succeeds", async () => {
    let started!: (value: unknown) => void;
    json.mockImplementation(
      () =>
        new Promise((resolve) => {
          started = resolve;
        }),
    );
    const { port, answers } = await framePort(readsButtons);
    for (let capture = 1; capture <= capturesAllowed; capture++) {
      port.postMessage({ type: "capture", capture, device: "remote-1" });
    }
    await vi.waitFor(() =>
      expect(callsTo("/api/devices/capture/start")).toHaveLength(
        capturesAllowed,
      ),
    );
    port.postMessage({
      type: "request",
      id: 1,
      op: "release",
      capture: capturesAllowed,
    });
    port.postMessage({
      type: "capture",
      capture: capturesAllowed + 1,
      device: "remote-1",
    });
    await vi.waitFor(() =>
      expect(answers).toContainEqual({
        type: "captureEnded",
        capture: capturesAllowed + 1,
        reason: "failed",
      }),
    );
    expect(answerTo(answers, 1)).toBeUndefined();
    json.mockRejectedValueOnce(new Error("offline"));
    started({
      id: "late",
      device: "remote-1",
      until: new Date(Date.now() + 5 * 60_000).toISOString(),
    });
    await vi.waitFor(() =>
      expect(answerTo(answers, 1)).toMatchObject({ ok: false }),
    );
    json.mockResolvedValue(undefined);
    port.postMessage({
      type: "request",
      id: 2,
      op: "release",
      capture: capturesAllowed,
    });
    await vi.waitFor(() =>
      expect(answerTo(answers, 2)).toMatchObject({ ok: true }),
    );
    expect(callsTo("/api/devices/capture/stop")).toHaveLength(2);
  });

  it("retries a failed release after the frame closes", async () => {
    capturesStart();
    const { port, bridge } = await framePort(readsButtons);
    port.postMessage({ type: "capture", capture: 1, device: "remote-1" });
    await vi.waitFor(() =>
      expect(callsTo("/api/devices/capture/start")).toHaveLength(1),
    );
    vi.useFakeTimers();
    try {
      json.mockRejectedValueOnce(new Error("offline"));
      bridge.close();
      await vi.advanceTimersByTimeAsync(0);
      expect(callsTo("/api/devices/capture/stop")).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(callsTo("/api/devices/capture/stop")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { change: "button access is revoked", app: info },
    {
      change: "the app pauses",
      app: { ...readsButtons, state: "paused" as const },
    },
  ])(
    "ends a capture when $change, even while another capture suppresses the remote",
    async ({ app }) => {
      capturesStart();
      const { port, answers, renew } = await framePort(readsButtons);
      port.postMessage({ type: "capture", capture: 1, device: "remote-1" });
      await vi.waitFor(() =>
        expect(callsTo("/api/devices/capture/start")).toHaveLength(1),
      );
      const press = {
        type: "press" as const,
        device: "remote-1",
        capability: "button",
        action: "single",
        at: new Date().toISOString(),
        isCaptured: true,
      };
      live.publish(press);
      await vi.waitFor(() =>
        expect(answers.filter((each) => each.type === "captured")).toHaveLength(
          1,
        ),
      );
      renew(app);
      live.publish({ ...press, action: "double" });
      await vi.waitFor(() =>
        expect(answers).toContainEqual({
          type: "captureEnded",
          capture: 1,
          reason: "failed",
        }),
      );
      expect(answers.filter((each) => each.type === "captured")).toHaveLength(
        1,
      );
      expect(callsTo("/api/devices/capture/stop")).toHaveLength(1);
    },
  );

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

import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

// The preload as it runs in the client's main frame and in a frame an app's
// page shows in, compiled from its source and run with Electron's bridge
// stood in for; the code it gives the page's world runs against a world of
// the test's own.

const source = readFileSync(
  new URL("../src/preload.cts", import.meta.url),
  "utf8",
);
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS },
});

function preloadIn(frame: "main" | "sub") {
  const bridge = {
    exposeInMainWorld: vi.fn(),
    executeInMainWorld: vi.fn(),
  };
  const electron = {
    contextBridge: bridge,
    ipcRenderer: { invoke: vi.fn(), on: vi.fn(), off: vi.fn(), send: vi.fn() },
  };
  const run = new Function("require", "exports", "process", outputText);
  run(
    (name: string) => {
      if (name !== "electron") throw new Error(`No ${name} in a preload`);
      return electron;
    },
    {},
    { isMainFrame: frame === "main", platform: "darwin" },
  );
  return bridge;
}

describe("the preload", () => {
  it("gives the client's main frame its bridge, and leaves WebRTC to it", () => {
    const bridge = preloadIn("main");
    expect(bridge.exposeInMainWorld).toHaveBeenCalledWith(
      "sanctumShell",
      expect.objectContaining({ frames: expect.any(Object) }),
    );
    expect(bridge.executeInMainWorld).not.toHaveBeenCalled();
  });

  it("gives a frame no bridge, and takes every RTC global out of its page's world", () => {
    const bridge = preloadIn("sub");
    expect(bridge.exposeInMainWorld).not.toHaveBeenCalled();
    const [{ func }] = bridge.executeInMainWorld.mock.calls[0]! as [
      { func: () => void },
    ];
    const world = globalThis as Record<string, unknown>;
    world.RTCPeerConnection = class {};
    world.webkitRTCPeerConnection = class {};
    world.RTCDataChannel = class {};
    world.RTC_kept = undefined;
    world.NotRTC = "kept";
    try {
      func();
      expect(world.RTCPeerConnection).toBeUndefined();
      expect(world.webkitRTCPeerConnection).toBeUndefined();
      expect(world.RTCDataChannel).toBeUndefined();
      expect("RTCPeerConnection" in world).toBe(false);
      expect(world.NotRTC).toBe("kept");
    } finally {
      for (const name of [
        "RTCPeerConnection",
        "webkitRTCPeerConnection",
        "RTCDataChannel",
        "RTC_kept",
        "NotRTC",
      ]) {
        delete world[name];
      }
    }
  });
});

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createServer } from "vite";
import { expect, it, vi } from "vitest";

import { displayBridge } from "../dev/display.ts";

it("serves the display handshake and records only bounded JSON lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "sanctum-display-"));
  try {
    const touchLog = join(root, "touches.jsonl");
    await writeFile(join(root, "index.html"), "<html><head></head></html>");
    const server = await createServer({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [displayBridge(touchLog)],
      optimizeDeps: { noDiscovery: true },
      server: { host: "127.0.0.1", port: 0, watch: null },
    });
    try {
      await server.listen();
      const { port } = server.httpServer!.address() as AddressInfo;
      const base = `http://127.0.0.1:${port}`;
      const post = (path: string, body: string) =>
        fetch(base + path, { method: "POST", body });

      const login = await post("/auth/login_flow", "{}");
      expect(login.status).toBe(200);
      expect(await login.json()).toMatchObject({
        type: "form",
        step_id: "init",
      });
      expect(await (await fetch(base)).text()).toContain(
        "/dev/display-touches.js",
      );

      const touchRoute = "/__display/touches";
      expect((await post(touchRoute, "too large".repeat(8_000))).status).toBe(
        413,
      );
      expect((await post(touchRoute, "invalid json")).status).toBe(400);
      expect((await post(touchRoute, '{\n"events":[]\n}')).status).toBe(204);
      expect(await readFile(touchLog, "utf8")).toBe('{"events":[]}\n');

      await rm(touchLog);
      await mkdir(touchLog);
      expect((await post(touchRoute, "{}")).status).toBe(500);
      expect((await post("/auth/login_flow", "{}")).status).toBe(200);
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("records two rapid taps as separate gestures and ignores mouse events", async () => {
  const script = await readFile(
    new URL("../dev/display-touches.js", import.meta.url),
    "utf8",
  );
  vi.useFakeTimers();
  try {
    const handlers = new Map<string, (event: object) => void>();
    const fetch = vi.fn(
      async (_url: string, _options: { body: string }) => ({}),
    );
    runInNewContext(script, {
      document: { addEventListener: handlers.set.bind(handlers) },
      Element: class {},
      performance,
      setTimeout,
      clearTimeout,
      fetch,
    });

    const send = (type: string, props: object) => handlers.get(type)!(props);
    const tap = (x: number) => {
      const point = { clientX: x, clientY: 0 };
      const pointer = { ...point, pointerType: "touch", pointerId: 1 };
      send("pointerdown", pointer);
      send("touchstart", { touches: [point] });
      send("pointerup", pointer);
      send("touchend", { touches: [], changedTouches: [point] });
      send("lostpointercapture", pointer);
    };

    send("pointermove", { clientX: 99, pointerType: "mouse" });
    tap(10);
    vi.advanceTimersByTime(50);
    tap(20);
    vi.runAllTimers();

    const gestures = fetch.mock.calls.map(([, { body }]) => JSON.parse(body));
    expect(gestures.map(({ end }) => end)).toEqual(["touchend", "touchend"]);
    expect(
      gestures.map(({ events }) =>
        events.map(([, , x]: [number, string, number, number]) => x),
      ),
    ).toEqual([Array(5).fill(10), Array(5).fill(20)]);
  } finally {
    vi.useRealTimers();
  }
});

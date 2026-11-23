import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { createServer } from "vite";
import { expect, it, vi } from "vitest";

import { summariseRuns } from "../dev/display-frames-summary.ts";
import { builtPath, displayBridge } from "../dev/display.ts";

it("serves the display handshake and records only bounded JSON lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "sanctum-display-"));
  try {
    const touchLog = join(root, "touches.jsonl");
    await writeFile(join(root, "index.html"), "<html><head></head></html>");
    const server = await createServer({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [displayBridge({ touchLog })],
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

it("records frame timings, serves the blank page and the built client, and follows its control", async () => {
  const root = await mkdtemp(join(tmpdir(), "sanctum-display-"));
  try {
    const frameLog = join(root, "frames.jsonl");
    const builtDir = join(root, "dist-display");
    await writeFile(join(root, "index.html"), "<html><head></head></html>");
    const server = await createServer({
      configFile: false,
      root,
      logLevel: "silent",
      plugins: [displayBridge({ frameLog, builtDir })],
      optimizeDeps: { noDiscovery: true },
      server: { host: "127.0.0.1", port: 0, watch: null },
    });
    try {
      await server.listen();
      const { port } = server.httpServer!.address() as AddressInfo;
      const base = `http://127.0.0.1:${port}`;
      const post = (path: string, body: string) =>
        fetch(base + path, { method: "POST", body });

      // The dev page and the blank one carry the recorder.
      expect(await (await fetch(base)).text()).toContain(
        "/dev/display-frames.js",
      );
      const blank = await fetch(base + "/__display/blank");
      expect(blank.status).toBe(200);
      expect(await blank.text()).toContain("/dev/display-frames.js");

      // Timings are kept as JSON lines.
      expect((await post("/__display/frames", "[]")).status).toBe(400);
      expect((await post("/__display/frames", '{"frames":[]}')).status).toBe(
        204,
      );
      expect(await readFile(frameLog, "utf8")).toBe('{"frames":[]}\n');

      // The built client: a note until it is built, then its page with the
      // recorder for any route, and its files.
      const missing = await fetch(base + builtPath);
      expect(missing.status).toBe(404);
      expect(await missing.text()).toContain("build:display");
      await mkdir(join(builtDir, "assets"), { recursive: true });
      await writeFile(
        join(builtDir, "index.html"),
        "<html><head></head></html>",
      );
      await writeFile(join(builtDir, "assets", "index.js"), "export {};");
      for (const path of [builtPath, "/__display/built", builtPath + "home"]) {
        const page = await fetch(base + path);
        expect(page.headers.get("content-type")).toBe("text/html");
        expect(await page.text()).toBe(
          '<html><head><script type="module" src="/dev/display-frames.js"></script></head></html>',
        );
      }
      const script = await fetch(base + builtPath + "assets/index.js");
      expect(script.headers.get("content-type")).toBe("text/javascript");
      expect(await script.text()).toBe("export {};");
      expect((await fetch(base + builtPath + "assets/none.js")).status).toBe(
        404,
      );
      expect(
        (await fetch(base + builtPath + "..%2f..%2findex.html.js")).status,
      ).toBe(404);

      // The control: what the display is told, changed from this Mac.
      const control = async () =>
        (await fetch(base + "/__display/control")).json();
      expect(await control()).toEqual({
        page: "dev",
        label: "",
        blur: true,
        masks: true,
        prompt: "",
        reload: 0,
        path: "/",
      });
      expect(
        (await post("/__display/control", '{"page":"elsewhere"}')).status,
      ).toBe(400);
      const changed = await post(
        "/__display/control",
        '{"page":"built","label":"home idle","blur":false,"prompt":"Scroll","reload":true}',
      );
      expect(await changed.json()).toEqual({
        page: "built",
        label: "home idle",
        blur: false,
        masks: true,
        prompt: "Scroll",
        reload: 1,
        path: builtPath,
      });
      expect(await control()).toMatchObject({ page: "built", reload: 1 });
    } finally {
      await server.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("sums up each run's frames, input and long frames", () => {
  const runs = summariseRuns([
    {
      page: "built",
      label: "scroll",
      blur: true,
      masks: true,
      frames: [
        { at: 0, count: 30, p50: 33, p95: 50, max: 80, over50: 3, over100: 0 },
        {
          at: 1000,
          count: 20,
          p50: 50,
          p95: 90,
          max: 120,
          over50: 7,
          over100: 1,
        },
      ],
      moves: [{ at: 0, count: 12, p50: 75, p95: 80, max: 90, coalesced: 12 }],
      events: [
        { name: "pointerdown", delay: 40, duration: 120 },
        { name: "pointermove", delay: 500, duration: 600 },
      ],
      loafs: [
        {
          duration: 100,
          blocking: 50,
          render: 60,
          scripts: [
            { duration: 30, invoker: "Response.json.then", source: "index.js" },
          ],
        },
      ],
    },
    { page: "built", label: "scroll", blur: true, masks: true, frames: [] },
    { page: "blank", label: "", blur: true, masks: true },
  ]);
  expect(runs).toEqual([
    {
      page: "built",
      label: "scroll",
      blur: true,
      masks: true,
      seconds: 2,
      fps: 25,
      frameGapP50: 50,
      frameGapP95: 90,
      slowFrameShare: 20,
      moveGapP50: 75,
      inputs: 1,
      inputDelayP50: 40,
      inputDelayP95: 40,
      inputToPaintP95: 120,
      longFrames: 1,
      blockingMs: 50,
      renderShareOfLongFrames: 60,
      topScripts: [{ name: "Response.json.then · index.js", ms: 30 }],
    },
    expect.objectContaining({ page: "blank", seconds: 0, fps: 0 }),
  ]);
});

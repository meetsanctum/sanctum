import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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

async function recordDisplay(
  address = "http://localhost:8123/",
  effects?: string,
) {
  const script = await readFile(
    new URL("../dev/display-frames.js", import.meta.url),
    "utf8",
  );
  const handlers = new Map<string, (event?: object) => void>();
  const posts: Record<string, unknown>[] = [];
  let control = {
    page: "dev",
    label: "scroll",
    blur: true,
    masks: true,
    prompt: "",
    reload: 0,
    path: "/",
  };
  let now = 0;
  let nextFrame: (at: number) => void;
  let poll: () => void;
  let effectsChanged: () => void;
  const document = {
    hidden: false,
    documentElement: { dataset: { effects } },
    addEventListener: handlers.set.bind(handlers),
    querySelector: () => ({ innerText: "Home Lights" }),
    getElementById: () => null,
    createElement: () => ({}),
    head: { append: () => {} },
  };
  const assign = vi.fn();
  const location = Object.assign(new URL(address), { assign });
  if (location.pathname.startsWith(builtPath)) {
    control = { ...control, page: "built", path: builtPath };
  }
  runInNewContext(script, {
    AbortSignal,
    URL,
    URLSearchParams,
    location,
    MutationObserver: class {
      constructor(private callback: () => void) {}
      observe(target: unknown, options: MutationObserverInit) {
        expect(target).toBe(document.documentElement);
        expect(options.attributeFilter).toEqual(["data-effects"]);
        effectsChanged = this.callback;
      }
    },
    performance: { now: () => now },
    requestAnimationFrame: (callback: typeof nextFrame) => {
      nextFrame = callback;
    },
    setInterval: (callback: typeof poll) => {
      poll = callback;
    },
    addEventListener: handlers.set.bind(handlers),
    document,
    innerWidth: 1264,
    innerHeight: 724,
    devicePixelRatio: 1,
    navigator: {},
    fetch: async (url: string, options: { body: string }) => {
      if (url === "/__display/control") {
        return { ok: true, json: async () => control };
      }
      posts.push(JSON.parse(options.body));
      return { ok: true };
    },
  });
  const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
  const frame = (at: number) => nextFrame((now = at));
  const setControl = async (changes: Partial<typeof control>, at = now) => {
    now = at;
    control = { ...control, ...changes };
    poll();
    await settle();
  };
  const setEffects = (effects: string | undefined, at: number) => {
    now = at;
    document.documentElement.dataset.effects = effects;
    effectsChanged();
  };

  await settle();
  posts.length = 0;
  return { handlers, posts, frame, document, setControl, setEffects, assign };
}

it("keeps short drags and partial frame windows with the settings that measured them", async () => {
  const { handlers, posts, frame, document, setControl } =
    await recordDisplay();
  const touch = (type: string, timeStamp: number, isPrimary = true) =>
    handlers.get(`pointer${type}`)!({
      pointerType: "touch",
      isPrimary,
      timeStamp,
    });

  frame(10);
  frame(30);
  touch("move", 40);
  touch("move", 55, false);
  touch("move", 70);
  touch("up", 80);
  touch("down", 90);
  touch("move", 100);
  touch("move", 130);

  await setControl({ blur: false }, 150);
  frame(160);
  frame(185);
  document.hidden = true;
  handlers.get("visibilitychange")!();
  frame(700);
  document.hidden = false;
  handlers.get("visibilitychange")!();
  frame(800);
  frame(830);
  handlers.get("pagehide")!();

  expect(posts).toEqual([
    expect.objectContaining({
      label: "scroll",
      blur: true,
      moves: [expect.objectContaining({ coalesced: 4, count: 2, p50: 30 })],
    }),
    expect.objectContaining({
      blur: true,
      frames: [expect.objectContaining({ count: 1, durationMs: 20 })],
    }),
    expect.objectContaining({
      blur: false,
      shows: "Home Lights",
      frames: [expect.objectContaining({ count: 1, durationMs: 25 })],
    }),
    expect.objectContaining({
      blur: false,
      frames: [expect.objectContaining({ count: 1, durationMs: 30 })],
    }),
  ]);
});

it.each([
  ["/?effects=regular&other=1", "built", builtPath, "regular"],
  [`${builtPath}?effects=reduced`, "dev", "/", "reduced"],
])(
  "keeps the effects override when switching from %s",
  async (from, page, path, effects) => {
    const origin = "http://localhost:8123";
    const { assign, setControl } = await recordDisplay(origin + from);

    await setControl({ page, path });

    expect(assign).toHaveBeenCalledExactlyOnceWith(
      `${origin}${path}?effects=${effects}`,
    );
  },
);

it("keeps frame timings separate when Reduce effects changes the blur setting", async () => {
  const { handlers, posts, frame, setEffects } = await recordDisplay(
    "http://localhost:8123/",
    "reduced",
  );

  frame(10);
  frame(30);
  setEffects(undefined, 40);
  frame(50);
  frame(75);
  setEffects("reduced", 80);
  frame(90);
  frame(120);
  handlers.get("pagehide")!();

  expect(posts).toEqual([
    expect.objectContaining({
      blur: false,
      frames: [expect.objectContaining({ count: 1, durationMs: 20 })],
    }),
    expect.objectContaining({
      blur: true,
      frames: [expect.objectContaining({ count: 1, durationMs: 25 })],
    }),
    expect.objectContaining({
      blur: false,
      frames: [expect.objectContaining({ count: 1, durationMs: 30 })],
    }),
  ]);
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
      plugins: [
        displayBridge({
          frameLog,
          builtDir,
          touchLog: join(root, "touches.jsonl"),
        }),
      ],
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
      expect(
        (await post("/__display/control", '{"page":"built"}')).status,
      ).toBe(409);
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
          '<html><head><script type="module" src="/dev/display-touches.js"></script><script type="module" src="/dev/display-frames.js"></script></head></html>',
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
      expect(
        (await post("/__display/control", '{"page":["dev"]}')).status,
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
      shows: "Home Lights",
      frames: [
        { count: 30, p50: 33, p95: 50, over50: 3 },
        {
          durationMs: 1500,
          count: 20,
          p50: 50,
          p95: 90,
          over50: 7,
        },
      ],
      moves: [{ count: 12, p50: 75 }],
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
    {
      page: "built",
      label: "scroll",
      blur: true,
      masks: true,
      frames: [],
      shows: "Office Light",
    },
    {
      page: "built",
      label: "scroll",
      blur: true,
      masks: true,
      shows: "Home Lights",
    },
    { page: "blank", label: "", blur: true, masks: true },
  ]);
  expect(runs).toEqual([
    {
      page: "built",
      label: "scroll",
      blur: true,
      masks: true,
      screens: ["Home Lights", "Office Light"],
      seconds: 2.5,
      fps: 20,
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

it("summarises valid timings when the log contains invalid or incomplete lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "sanctum-display-"));
  try {
    const log = join(root, "frames.jsonl");
    const run = { page: "built", label: "scroll", blur: true, masks: true };
    await writeFile(
      log,
      [
        JSON.stringify({ ...run, frames: "missing samples" }),
        JSON.stringify({ ...run, shows: "Home" }),
        '{"page":',
      ].join("\n"),
    );
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [
      fileURLToPath(
        new URL("../dev/display-frames-summary.ts", import.meta.url),
      ),
      log,
      "--json",
    ]);
    expect(JSON.parse(stdout)).toEqual([
      expect.objectContaining({ ...run, screens: ["Home"] }),
    ]);
    expect(stderr).toContain("line 1");
    expect(stderr).toContain("line 3");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

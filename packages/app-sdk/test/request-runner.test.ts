import { expect, it, vi } from "vitest";

import {
  assistantAppId,
  assistantRequestSchema,
  defineApp,
} from "../src/index.js";
import type { CallBody, Outcome } from "../src/protocol.js";
import { createCallHost } from "../src/runner-calls.js";

it("accepts a room only on a speaker request", () => {
  const request = { text: "Hello", language: "en", earlier: [] };
  const room = { id: "office", name: "Office" };
  expect(
    assistantRequestSchema.safeParse({
      ...request,
      room,
      from: { kind: "client", name: "Tablet" },
    }).success,
  ).toBe(false);
  expect(
    assistantRequestSchema.safeParse({
      ...request,
      room,
      from: { kind: "speaker", name: "Speaker" },
    }).success,
  ).toBe(true);
});

it("runs the Assistant's method and sends its reply without opening app storage", async () => {
  const app = defineApp({
    id: assistantAppId,
    name: "Assistant",
    version: "1.0.0",
    core: "^2.0.0",
    permissions: [],
    actions: [],
    events: [],
    async requests(ctx, request) {
      expect(ctx).not.toHaveProperty("storage");
      await request.reply({ text: `${this.name}: ${request.text}` });
    },
  });
  const storage = {
    call: vi.fn(() => ({ ended: false, end: vi.fn(), query: vi.fn() })),
    close: vi.fn(),
    sync: vi.fn(),
  };
  const request = vi.fn().mockResolvedValue(undefined);
  const runner = createCallHost({
    app,
    storage,
    request,
    log: vi.fn(),
    answer: vi.fn(),
  });
  const call = (id: string, body: CallBody) =>
    new Promise<Outcome>((resolve) => {
      runner.take(
        {
          type: "call",
          id,
          deadlineMs: 1_000,
          actor: { kind: "client", id: "tablet" },
          body,
        },
        resolve,
      );
    });

  expect(await call("1.1", { kind: "start", reason: "started" })).toMatchObject(
    {
      ok: true,
    },
  );
  expect(
    await call("1.2", {
      kind: "request",
      request: {
        text: "Hello",
        language: "en",
        room: null,
        from: { kind: "client", name: "Tablet" },
        earlier: [],
      },
    }),
  ).toEqual({ ok: true, value: null });
  expect(storage.call).toHaveBeenCalledOnce();
  expect(request).toHaveBeenCalledExactlyOnceWith(
    "1.2",
    "replyRequest",
    [{ text: "Assistant: Hello" }],
    expect.any(Function),
  );
});

function startableRunner(
  handler: NonNullable<Parameters<typeof createCallHost>[0]["app"]["requests"]>,
) {
  const app = defineApp({
    id: assistantAppId,
    name: "Assistant",
    version: "1.0.0",
    core: "^2.0.0",
    permissions: [],
    actions: [],
    events: [],
    requests: handler,
  });
  const runner = createCallHost({
    app,
    storage: {
      call: vi.fn(() => ({ ended: false, end: vi.fn(), query: vi.fn() })),
      close: vi.fn(),
      sync: vi.fn(),
    },
    request: vi.fn(),
    log: vi.fn(),
    answer: vi.fn(),
  });
  const call = (id: string, body: CallBody, deadlineMs = 1_000) =>
    new Promise<Outcome>((resolve) => {
      runner.take(
        {
          type: "call",
          id,
          deadlineMs,
          actor: { kind: "client", id: "tablet" },
          body,
        },
        resolve,
      );
    });
  const requestBody = {
    kind: "request",
    request: {
      text: "Hello",
      language: "en",
      room: null,
      from: { kind: "client", name: "Tablet" },
      earlier: [],
    },
  } satisfies CallBody;
  return {
    runner,
    start: () => call("1.1", { kind: "start", reason: "started" }),
    request: (deadlineMs?: number) => call("1.2", requestBody, deadlineMs),
  };
}

it("aborts a request's signal when the core ends its call", async () => {
  let started!: () => void;
  const entered = new Promise<void>((resolve) => (started = resolve));
  const aborted = vi.fn();
  const { runner, start, request } = startableRunner(async (_ctx, asked) => {
    started();
    await new Promise((ended) =>
      asked.signal.addEventListener("abort", ended, { once: true }),
    );
    aborted(asked.signal.aborted);
  });
  await start();
  const answered = request();
  await entered;
  runner.end("1.2");
  expect(await answered).toEqual({ ok: true, value: null });
  expect(aborted).toHaveBeenCalledWith(true);
});

it("skips a request the core ends before the handler starts", async () => {
  const handled = vi.fn();
  const { runner, start, request } = startableRunner(handled);
  await start();
  const answered = request();
  runner.end("1.2");
  await expect(answered).resolves.toMatchObject({
    ok: false,
    code: "turn_ended",
  });
  expect(handled).not.toHaveBeenCalled();
});

it("aborts the request's signal at the runner deadline", async () => {
  vi.useFakeTimers();
  try {
    const aborted = vi.fn();
    const { start, request } = startableRunner(async (_ctx, asked) => {
      await new Promise((ended) =>
        asked.signal.addEventListener("abort", ended, { once: true }),
      );
      aborted();
    });
    await start();
    const answered = request(100);
    await vi.advanceTimersByTimeAsync(99);
    expect(aborted).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(aborted).toHaveBeenCalledOnce();
    await expect(answered).resolves.toEqual({ ok: true, value: null });
  } finally {
    vi.useRealTimers();
  }
});

it("keeps a new request cancellable after an old request with the same id finishes", async () => {
  let firstEntered!: () => void;
  let secondEntered!: () => void;
  let releaseFirst!: () => void;
  const firstStarted = new Promise<void>((resolve) => (firstEntered = resolve));
  const secondStarted = new Promise<void>(
    (resolve) => (secondEntered = resolve),
  );
  const firstReleased = new Promise<void>(
    (resolve) => (releaseFirst = resolve),
  );
  let firstSignal: AbortSignal | undefined;
  const secondAborted = vi.fn();
  const { runner, request, start } = startableRunner(async (_ctx, asked) => {
    if (!firstSignal) {
      firstSignal = asked.signal;
      firstEntered();
      await firstReleased;
      return;
    }
    secondEntered();
    await new Promise((ended) =>
      asked.signal.addEventListener("abort", ended, { once: true }),
    );
    secondAborted();
  });
  await start();
  const old = request();
  await firstStarted;
  expect(await runner.lost(100)).toBe(true);
  expect(firstSignal?.aborted).toBe(true);
  await start();
  const current = request();
  await secondStarted;
  releaseFirst();
  await old;

  runner.end("1.2");
  await new Promise((done) => setImmediate(done));
  expect(secondAborted).toHaveBeenCalledOnce();
  await current;
});

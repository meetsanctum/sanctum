import { expect, it, vi } from "vitest";

import { assistantAppId, defineApp } from "../src/index.js";
import type { CallBody, Outcome } from "../src/protocol.js";
import { createCallHost } from "../src/runner-calls.js";

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
      request: { text: "Hello", language: "en", clientName: "Tablet" },
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

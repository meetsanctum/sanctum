import {
  aiAssistantPermission,
  assistantAppId,
  turnLimits,
  type AppDefinition,
  type RequestContext,
} from "@meetsanctum/app-sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ActionCallError } from "../src/app-host/errors.js";
import type { InstalledApp } from "../src/app-host/installed.js";
import { createRequests } from "../src/app-host/requests.js";
import type { Turn } from "../src/models/turns.js";
import { deferredDelivery, deferredResult } from "./support.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setUp(
  handler: NonNullable<AppDefinition["requests"]>,
  overrides: Partial<Parameters<typeof createRequests>[0]> = {},
) {
  const app = { id: assistantAppId, name: "Assistant", requests: handler };
  const entry = { app, granted: [aiAssistantPermission] } as InstalledApp;
  const turn = {
    open: vi.fn(),
    read: vi.fn(),
    cancel: vi.fn(),
    end: vi.fn(),
  } satisfies Turn;
  type Options = Parameters<typeof createRequests>[0];
  const contexts = new WeakMap<RequestContext, ReturnType<Options["coreOf"]>>();
  const log = vi.fn();
  const arrives = vi.fn<Options["arrives"]>().mockResolvedValue(true);
  const requests = createRequests({
    installed: new Map([[assistantAppId, entry]]),
    accepts: () => true,
    arrives,
    contextFor(_entry, actor, scope, { reply }) {
      const context = { appId: assistantAppId, actor } as RequestContext;
      contexts.set(context, {
        async replyRequest(answer) {
          if (scope.ended) throw new Error("This call has ended");
          reply(answer);
        },
      });
      return context;
    },
    coreOf: (ctx) => contexts.get(ctx)!,
    turnFor: () => turn,
    track: (_entry, call) => call,
    log,
    ...overrides,
  });
  const ask = (clientId = "tablet", checkClient = () => {}) =>
    requests.ask({
      actor: { kind: "client", id: clientId },
      who: { clientId },
      asked: { text: "Hello", language: "en", clientName: "Tablet" },
      checkClient,
    });
  return { ask, close: requests.close, arrives, entry, log, turn };
}

describe("Assistant request admission and lifetime", () => {
  it("settles a stalled request at the deadline and refuses a late reply", async () => {
    const release = deferredDelivery();
    const late = deferredResult<unknown>();
    const { ask, turn } = setUp(async (_ctx, request) => {
      await release.promise;
      try {
        await request.reply({ text: "Here." });
        late.resolve(undefined);
      } catch (error) {
        late.resolve(error);
      }
    });

    const answered = ask();
    await vi.advanceTimersByTimeAsync(turnLimits.turnMs - 1);
    expect(turn.end).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(answered).resolves.toBeNull();
    expect(turn.end).toHaveBeenCalledOnce();
    release.resolve();
    expect(await late.promise).toBeInstanceOf(Error);
  });

  it("refuses a stalled request and closes its turn when the core stops", async () => {
    const entered = deferredDelivery();
    const release = deferredDelivery();
    const { ask, close, turn } = setUp(async () => {
      entered.resolve();
      await release.promise;
    });

    const answered = ask();
    await entered.promise;
    close();

    await expect(answered).rejects.toMatchObject({ code: "unavailable" });
    await expect(ask()).rejects.toMatchObject({ code: "unavailable" });
    expect(turn.end).toHaveBeenCalledOnce();
    release.resolve();
  });

  it("reports a lost connection only when the request has no reply", async () => {
    const failure = new ActionCallError("unavailable");
    const stopped = setUp(async () => {
      throw failure;
    });
    await expect(stopped.ask()).rejects.toBe(failure);

    const answered = setUp(async (_ctx, request) => {
      await request.reply({ text: "Here." });
      throw failure;
    });
    await expect(answered.ask()).resolves.toEqual({ text: "Here." });
  });

  it("settles even when the turn and handler fail, keeping private text out of logs", async () => {
    const { ask, log, turn } = setUp(async () => {
      throw new Error("Private request");
    });
    turn.end.mockImplementation(() => {
      throw new Error("Private activity");
    });

    await expect(ask()).resolves.toBeNull();
    expect(log.mock.calls).toEqual([
      ["apps: sanctum.assistant could not close a request's turn"],
      ["apps: sanctum.assistant request failed"],
    ]);
  });

  it("refuses a request without waiting if the Assistant lacks its grant", async () => {
    const { ask, arrives, entry } = setUp(vi.fn(), { accepts: () => false });
    entry.granted = [];

    await expect(ask()).rejects.toMatchObject({ code: "unavailable" });
    expect(arrives).not.toHaveBeenCalled();
  });

  it("checks the client's credential after the Assistant is ready", async () => {
    const ready = deferredResult<boolean>();
    let running = false;
    const handler = vi.fn();
    const { ask } = setUp(handler, {
      accepts: () => running,
      arrives: () => ready.promise,
    });
    const denied = new Error("The client was revoked");
    const checkClient = vi.fn(() => {
      throw denied;
    });

    const answered = ask("tablet", checkClient);
    expect(checkClient).not.toHaveBeenCalled();
    running = true;
    ready.resolve(true);

    await expect(answered).rejects.toBe(denied);
    expect(handler).not.toHaveBeenCalled();
  });

  it("keeps a client's slot until its handler finishes after an early reply", async () => {
    const release = deferredDelivery();
    const { ask, turn } = setUp(async (ctx, request) => {
      await request.reply({ text: "Here." });
      if (ctx.actor.id === "tablet") await release.promise;
    });

    await expect(ask()).resolves.toEqual({ text: "Here." });
    await expect(ask()).rejects.toMatchObject({ code: "limited" });
    await expect(ask("phone")).resolves.toEqual({ text: "Here." });

    release.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(turn.end).toHaveBeenCalledTimes(2);
    await expect(ask()).resolves.toEqual({ text: "Here." });
    await vi.advanceTimersByTimeAsync(0);
  });

  it("limits how many clients can have a request under way together", async () => {
    const release = deferredDelivery();
    const { ask } = setUp(async () => release.promise);
    const pending = Array.from({ length: 4 }, (_, index) =>
      ask(`client-${index}`),
    );

    await expect(ask("tablet")).rejects.toMatchObject({ code: "limited" });

    release.resolve();
    await expect(Promise.all(pending)).resolves.toEqual([
      null,
      null,
      null,
      null,
    ]);
    await expect(ask("tablet")).resolves.toBeNull();
  });

  it("limits repeated requests per client and across the home", async () => {
    const { ask } = setUp(async () => {});

    for (let client = 0; client < 5; client += 1) {
      for (let request = 0; request < 12; request += 1) {
        await expect(ask(`client-${client}`)).resolves.toBeNull();
      }
      await expect(ask(`client-${client}`)).rejects.toMatchObject({
        code: "limited",
      });
    }
    await expect(ask("tablet")).rejects.toMatchObject({ code: "limited" });

    await vi.advanceTimersByTimeAsync(60_000);
    await expect(ask("tablet")).resolves.toBeNull();
    await expect(ask("client-0")).resolves.toBeNull();
  });
});

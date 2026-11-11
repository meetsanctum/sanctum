import {
  ActionError,
  defineAction,
  type AppContext,
} from "@meetsanctum/app-sdk";
import { maxMessageBytes } from "@meetsanctum/app-sdk/protocol";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CorePeer } from "../src/core-peer.js";
import {
  createRunnerFixture,
  sql,
  statement,
  testApp,
} from "./runner-fixture.js";

const fixture = createRunnerFixture();

describe("actions", () => {
  const start = (running: CorePeer) =>
    running.call({ kind: "start", reason: "started" });

  it("runs one with its own schemas, as the actor the core names", async () => {
    const run = vi.fn(async (ctx: AppContext, input: { name: string }) => ({
      said: input.name,
      actor: ctx.actor.id,
    }));
    const running = await fixture.connected(
      testApp([
        defineAction({
          id: "test.runner.say",
          title: "Say",
          tier: "read",
          input: z.object({ name: z.string().trim() }),
          output: z.object({
            said: z.string(),
            actor: z.string(),
            added: z.string().default("by its schema"),
          }),
          run,
        }),
      ]),
    );
    await start(running);

    const outcome = await running.call(
      {
        kind: "action",
        action: "test.runner.say",
        input: { name: "  Ada " },
      },
      { actor: { kind: "user", id: "ada" } },
    );

    expect(outcome).toEqual({
      ok: true,
      value: { said: "Ada", actor: "ada", added: "by its schema" },
    });
  });

  it("refuses input its schema refuses, without running it", async () => {
    const run = vi.fn(async () => undefined);
    const running = await fixture.connected(
      testApp([
        defineAction({
          ...statement("test.runner.say"),
          input: z.object({ name: z.string() }),
          run,
        }),
      ]),
    );
    await start(running);

    expect(
      await running.call({
        kind: "action",
        action: "test.runner.say",
        input: {},
      }),
    ).toMatchObject({ ok: false, code: "invalid_request" });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses an action it doesn't have", async () => {
    const running = await fixture.connected(testApp());
    await start(running);

    expect(
      await running.call({ kind: "action", action: "nope", input: {} }),
    ).toMatchObject({ ok: false, code: "not_found" });
  });

  it("keeps a refusal's code, and any other failure is the app's", async () => {
    const running = await fixture.connected(
      testApp([
        defineAction({
          ...statement("test.runner.refuses"),
          run: async () => {
            throw new ActionError("conflict", "It is taken");
          },
        }),
        defineAction({
          ...statement("test.runner.fails"),
          run: async () => {
            throw new Error("It broke");
          },
        }),
      ]),
    );
    await start(running);

    expect(
      await running.call({
        kind: "action",
        action: "test.runner.refuses",
        input: {},
      }),
    ).toEqual({ ok: false, code: "conflict", message: "It is taken" });
    expect(
      await running.call({
        kind: "action",
        action: "test.runner.fails",
        input: {},
      }),
    ).toEqual({ ok: false, message: "It broke" });
  });

  it("fails one whose output its schema refuses, or whose schema throws", async () => {
    const running = await fixture.connected(
      testApp([
        defineAction({
          ...statement("test.runner.badOutput"),
          output: z.object({ name: z.string() }),
          run: async () => ({ name: 1 }) as never,
        }),
        defineAction({
          ...statement("test.runner.throwingSchema"),
          input: z.object({}).transform(() => {
            throw new Error("Its transform threw");
          }),
        }),
      ]),
    );
    await start(running);

    expect(
      await running.call({
        kind: "action",
        action: "test.runner.badOutput",
        input: {},
      }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("output schema refuses"),
    });
    const threw = await running.call({
      kind: "action",
      action: "test.runner.throwingSchema",
      input: {},
    });
    expect(threw).toMatchObject({
      ok: false,
      message: expect.stringContaining("schema failed"),
    });
    expect(threw).not.toHaveProperty("code");
  });

  it("answers a failure when an answer won't fit a message", async () => {
    const running = await fixture.connected(
      testApp([
        defineAction({
          ...statement("test.runner.big"),
          run: async () => "x".repeat(maxMessageBytes),
        }),
      ]),
    );
    await start(running);

    expect(
      await running.call({
        kind: "action",
        action: "test.runner.big",
        input: {},
      }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("could not be sent"),
    });
    await running.beat();
  });

  it("carries a refusal from the core back as its code", async () => {
    const running = await fixture.connected(
      testApp([
        defineAction({
          ...statement("test.runner.reads"),
          run: async (ctx) => ctx.devices.state("device:1"),
        }),
      ]),
      {
        device: async () => {
          throw new ActionError("not_found", "No such device");
        },
      },
    );
    await start(running);

    expect(
      await running.call({
        kind: "action",
        action: "test.runner.reads",
        input: {},
      }),
    ).toEqual({ ok: false, code: "not_found", message: "No such device" });
  });

  it("names each call in what the app does for it", async () => {
    const running = await fixture.connected(
      testApp([
        defineAction({
          ...statement("test.runner.reads"),
          run: (ctx) => ctx.people.list(),
        }),
      ]),
      { people: async () => [] },
    );
    await start(running);

    const first = running.issue({
      kind: "action",
      action: "test.runner.reads",
      input: {},
    });
    const second = running.issue({
      kind: "action",
      action: "test.runner.reads",
      input: {},
    });
    await Promise.all([first.answer, second.answer]);

    expect(running.requests).toEqual([
      { call: first.id, method: "people", params: [] },
      { call: second.id, method: "people", params: [] },
    ]);
  });

  it("refuses what a call does once it has ended", async () => {
    let kept: AppContext | undefined;
    const running = await fixture.connected(
      testApp([
        defineAction({
          ...statement("test.runner.keeps"),
          run: async (ctx) => {
            kept = ctx;
          },
        }),
      ]),
      { people: async () => [] },
    );
    await start(running);
    await running.call({
      kind: "action",
      action: "test.runner.keeps",
      input: {},
    });

    await expect(kept!.people.list()).rejects.toThrow("has ended");
    expect(running.requests).toEqual([]);
  });

  it("rolls back what a call left open when its time runs out", async () => {
    const running = await fixture.connected(
      testApp([
        defineAction({
          ...statement("test.runner.leavesItOpen"),
          run: async (ctx) => {
            await sql(ctx, "begin");
            await sql(ctx, "insert into things values ('half')");
            await new Promise(() => undefined);
          },
        }),
        defineAction({
          ...statement("test.runner.counts"),
          run: async (ctx) => sql(ctx, "select name from things"),
        }),
      ]),
    );
    await start(running);

    void running.call(
      { kind: "action", action: "test.runner.leavesItOpen", input: {} },
      { deadlineMs: 50 },
    );
    await new Promise((done) => setTimeout(done, 100));

    expect(
      await running.call({
        kind: "action",
        action: "test.runner.counts",
        input: {},
      }),
    ).toEqual({ ok: true, value: [] });
  });

  it("keeps its database to itself, refusing statements that change its shape", async () => {
    const running = await fixture.connected(
      testApp([
        defineAction({
          ...statement("test.runner.drops"),
          run: async (ctx) => sql(ctx, "drop table things"),
        }),
        defineAction({
          ...statement("test.runner.counts"),
          run: async (ctx) => sql(ctx, "select name from things"),
        }),
      ]),
    );
    await start(running);

    expect(
      await running.call({
        kind: "action",
        action: "test.runner.drops",
        input: {},
      }),
    ).toMatchObject({ ok: false });
    expect(
      await running.call({
        kind: "action",
        action: "test.runner.counts",
        input: {},
      }),
    ).toEqual({ ok: true, value: [] });
  });
});

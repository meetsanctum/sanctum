import { defineAction } from "@meetsanctum/app-sdk";
import {
  coreCallMethods,
  maxCallsUnderWay,
  maxMessageBytes,
} from "@meetsanctum/app-sdk/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  createRunnerFixture,
  sql,
  statement,
  testApp,
} from "./runner-fixture.js";

const fixture = createRunnerFixture();

describe("its calls into the core", () => {
  it.each(["returns", "times out"])(
    "drops queued requests when their parent call %s and frees their slots",
    async (ending) => {
      const releases: (() => void)[] = [];
      let background: Promise<PromiseSettledResult<unknown>[]> | undefined;
      let isHeld = true;
      const running = await fixture.connected(
        testApp([
          defineAction({
            ...statement("test.runner.queues"),
            run: async (ctx) => {
              background = Promise.allSettled(
                Array.from({ length: maxCallsUnderWay + 3 }, () =>
                  ctx.people.list(),
                ),
              );
              if (ending === "times out") {
                await new Promise(() => undefined);
              }
            },
          }),
          defineAction({
            ...statement("test.runner.reads"),
            run: (ctx) => ctx.people.list(),
          }),
        ]),
        {
          people: async () =>
            isHeld ? new Promise((done) => releases.push(() => done([]))) : [],
        },
      );
      await running.call({ kind: "start", reason: "started" });
      const queued = running.issue(
        {
          kind: "action",
          action: "test.runner.queues",
          input: {},
        },
        { deadlineMs: 100 },
      );
      await vi.waitFor(() => expect(releases).toHaveLength(maxCallsUnderWay));
      if (ending === "returns") {
        await queued.answer;
      } else {
        await new Promise((done) => setTimeout(done, 150));
        running.end(queued.id);
      }

      isHeld = false;
      releases.splice(0).forEach((release) => release());
      const outcomes = await background!;

      expect(running.requests).toHaveLength(maxCallsUnderWay);
      expect(running.refused).toEqual([]);
      expect(
        outcomes.filter(({ status }) => status === "rejected"),
      ).toHaveLength(3);
      expect(
        await running.call({
          kind: "action",
          action: "test.runner.reads",
          input: {},
        }),
      ).toEqual({ ok: true, value: [] });
    },
  );

  it("carries every one of them, and keeps query and log to itself", async () => {
    const running = await fixture.connected(
      testApp([
        defineAction({
          ...statement("test.runner.logs"),
          run: async (ctx) => {
            ctx.log("Said by the app");
            await sql(ctx, "select 1");
          },
        }),
      ]),
    );
    await running.call({ kind: "start", reason: "started" });

    await running.call({
      kind: "action",
      action: "test.runner.logs",
      input: {},
    });

    expect(coreCallMethods).not.toContain("query");
    expect(coreCallMethods).not.toContain("log");
    expect(running.requests).toEqual([]);
    expect(running.logs).toEqual(["Said by the app"]);
  });

  it("holds back all but so many at once", async () => {
    const releases: (() => void)[] = [];
    const running = await fixture.connected(
      testApp([
        defineAction({
          ...statement("test.runner.many"),
          run: async (ctx) => {
            await Promise.all(
              Array.from({ length: maxCallsUnderWay + 10 }, () =>
                ctx.people.list(),
              ),
            );
          },
        }),
      ]),
      {
        people: () => new Promise((done) => releases.push(() => done([]))),
      },
    );
    await running.call({ kind: "start", reason: "started" });

    const many = running.call({
      kind: "action",
      action: "test.runner.many",
      input: {},
    });
    await vi.waitFor(() => expect(releases).toHaveLength(maxCallsUnderWay));
    await new Promise((done) => setTimeout(done, 20));
    expect(releases).toHaveLength(maxCallsUnderWay);
    const release = async () => {
      while (running.requests.length <= maxCallsUnderWay + 10) {
        releases.splice(0).forEach((each) => each());
        if (running.requests.length === maxCallsUnderWay + 10) break;
        await new Promise((done) => setTimeout(done, 5));
      }
      releases.splice(0).forEach((each) => each());
    };
    await release();

    expect(await many).toMatchObject({ ok: true });
    expect(running.mostUnderWay).toBe(maxCallsUnderWay);
  });

  it("fails a call that won't fit a message, and goes on", async () => {
    const running = await fixture.connected(
      testApp([
        defineAction({
          ...statement("test.runner.huge"),
          run: async (ctx) =>
            ctx.entities.publish({
              type: "test",
              key: "huge",
              name: "Huge",
              state: "x".repeat(maxMessageBytes),
            }),
        }),
      ]),
      { publish: async () => undefined },
    );
    await running.call({ kind: "start", reason: "started" });

    expect(
      await running.call({
        kind: "action",
        action: "test.runner.huge",
        input: {},
      }),
    ).toMatchObject({
      ok: false,
      message: expect.stringContaining("over the limit"),
    });
    await running.beat();
  });

  it("fails what is under way when the connection goes", async () => {
    let failure: unknown;
    const running = await fixture.connected(
      testApp([
        defineAction({
          ...statement("test.runner.waits"),
          run: async (ctx) => {
            await ctx.people.list().catch((error: unknown) => {
              failure = error;
            });
          },
        }),
      ]),
      { people: () => new Promise(() => undefined) },
    );
    await running.call({ kind: "start", reason: "started" });

    void running.call({
      kind: "action",
      action: "test.runner.waits",
      input: {},
    });
    await vi.waitFor(() => expect(running.requests).toHaveLength(1));
    running.drop();

    await vi.waitFor(() => expect(failure).toBeInstanceOf(Error));
    expect((failure as Error).message).toBe(
      "The connection to the core has gone",
    );
  });
});

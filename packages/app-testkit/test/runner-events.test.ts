import {
  defineAction,
  type AppContext,
  type AppDefinition,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";
import {
  createRunnerFixture,
  sql,
  statement,
  testApp,
} from "./runner-fixture.js";

const fixture = createRunnerFixture();

describe("the core's events", () => {
  it("hands each to its handlers, as a call of its own", async () => {
    const seen: string[] = [];
    const running = await fixture.connected(
      testApp([], {
        start: async (ctx) => {
          await ctx.events.on("place.changed", async (event) => {
            await ctx.people.list();
            seen.push(event.name);
          });
        },
      }),
      { follow: async () => undefined, people: async () => [] },
    );
    const started = running.issue({ kind: "start", reason: "started" });
    await started.answer;

    const delivery = running.issue({
      kind: "event",
      event: { name: "place.changed" } as never,
    });

    expect(await delivery.answer).toMatchObject({ ok: true });
    expect(seen).toEqual(["place.changed"]);
    expect(running.requests).toEqual([
      { call: started.id, method: "follow", params: ["place.changed"] },
      { call: delivery.id, method: "people", params: [] },
    ]);
  });

  it("answers at once for an event nothing follows", async () => {
    const running = await fixture.connected(testApp());
    await running.call({ kind: "start", reason: "started" });

    expect(
      await running.call({
        kind: "event",
        event: { name: "place.changed" } as never,
      }),
    ).toMatchObject({ ok: true });
  });

  it("runs every handler though one fails, and says so", async () => {
    const seen: string[] = [];
    const running = await fixture.connected(
      testApp([], {
        start: async (ctx) => {
          await ctx.events.on("place.changed", async () => {
            throw new Error("First handler broke");
          });
          await ctx.events.on("place.changed", async () => {
            seen.push("second");
          });
        },
      }),
      { follow: async () => undefined },
    );
    await running.call({ kind: "start", reason: "started" });

    expect(
      await running.call({
        kind: "event",
        event: { name: "place.changed" } as never,
      }),
    ).toEqual({ ok: false, message: "First handler broke" });
    expect(seen).toEqual(["second"]);
  });

  it("rolls back what a handler left open", async () => {
    const running = await fixture.connected(
      testApp(
        [
          defineAction({
            ...statement("test.runner.counts"),
            run: async (ctx) => sql(ctx, "select name from things"),
          }),
        ],
        {
          start: async (ctx) => {
            await ctx.events.on("place.changed", async () => {
              await sql(ctx, "begin");
              await sql(ctx, "insert into things values ('half')");
            });
          },
        },
      ),
      { follow: async () => undefined },
    );
    await running.call({ kind: "start", reason: "started" });

    await running.call({
      kind: "event",
      event: { name: "place.changed" } as never,
    });

    expect(
      await running.call({
        kind: "action",
        action: "test.runner.counts",
        input: {},
      }),
    ).toEqual({ ok: true, value: [] });
  });
});

describe("a driver's hooks", () => {
  it("hands each its call, as the actor behind it", async () => {
    const seen: unknown[] = [];
    const hook =
      (name: string) => async (ctx: AppContext, params?: unknown) => {
        seen.push([name, ctx.actor.id, params]);
      };
    const driver: NonNullable<AppDefinition["driver"]> = {
      command: hook("command"),
      move: hook("move"),
      pairing: {
        open: async (ctx, params) => {
          seen.push(["open", ctx.actor.id, params]);
          return { until: null };
        },
        close: hook("close"),
      },
      remove: hook("remove"),
      firmware: {
        check: hook("check"),
        update: hook("update"),
        stop: hook("stop"),
      },
      probe: hook("probe"),
    };
    const running = await fixture.connected(testApp([], { driver }));
    await running.call({ kind: "start", reason: "started" });

    const hooks = [
      "command",
      "move",
      "pairing.open",
      "pairing.close",
      "remove",
      "firmware.check",
      "firmware.update",
      "firmware.stop",
      "probe",
    ] as const;
    for (const each of hooks) {
      expect(
        await running.call(
          { kind: "driver", hook: each, params: { key: "a" } },
          { actor: { kind: "user", id: "ada" } },
        ),
      ).toMatchObject({ ok: true });
    }

    expect(seen).toHaveLength(hooks.length);
    expect(seen[0]).toEqual(["command", "ada", { key: "a" }]);
    expect(seen[2]).toEqual(["open", "ada", { key: "a" }]);
  });

  it("is unavailable for a hook it doesn't have", async () => {
    const running = await fixture.connected(testApp());
    await running.call({ kind: "start", reason: "started" });

    expect(
      await running.call({ kind: "driver", hook: "probe", params: {} }),
    ).toMatchObject({ ok: false, code: "unavailable" });
  });
});

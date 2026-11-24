import {
  defineApp,
  type AppContext,
  type DriverAddResult,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { createDriverCore } from "../src/index.js";

// The suite core's adding and repairing that ask once started, with a TV
// that shows a first code once pairing starts, then a second that lasts.

function setup(options: { asks?: string } = {}) {
  const calls: string[] = [];
  const attempts: string[] = [];
  let context!: AppContext;
  const core = createDriverCore(
    defineApp({
      id: "sanctum.example",
      name: "Example",
      version: "0.1.0",
      core: "^2.0.0",
      permissions: [{ id: "devices.register", reason: "For the test." }],
      actions: [],
      events: [],
      async start(ctx) {
        context = ctx;
      },
      driver: {
        async command() {},
        questions: {
          first: {
            label: "Code on the TV (1 of 2)",
            kind: "code",
            length: 4,
            refusals: { wrongCode: "That code didn't match." },
          },
          second: {
            label: "Code on the TV (2 of 2)",
            kind: "code",
            length: 4,
            refusals: { wrongCode: "That code didn't match." },
            lasts: { seconds: 35, again: "Show a new code" },
          },
        },
        addLater: ["first", "second"],
        problems: {
          pairingLost: {
            words: "Its pairing was removed",
            repair: { asks: [], later: ["first", "second"] },
          },
        },
        async add(
          ctx,
          { key, answers, attempt, again },
        ): Promise<DriverAddResult> {
          calls.push(
            `add ${Object.keys(answers).join(" ")}${again ?? ""}`.trim(),
          );
          attempts.push(attempt!);
          if (options.asks) return { asks: [options.asks] };
          if (again) return { asks: [again] };
          if (answers.first !== undefined) {
            return answers.first === "1234"
              ? { asks: ["second"] }
              : {
                  asks: ["first"],
                  refused: { question: "first", refusal: "wrongCode" },
                };
          }
          if (answers.second !== undefined) {
            await ctx.devices.register({
              key,
              name: "Living Room",
              manufacturer: null,
              model: null,
              type: "unknown",
              capabilities: [],
            });
            return;
          }
          return { asks: ["first"] };
        },
        async cancelAdd(_ctx, { attempt }) {
          calls.push("cancelAdd");
          attempts.push(attempt);
        },
        async repair(_ctx, { answers }) {
          calls.push(`repair ${Object.keys(answers).join(" ")}`.trim());
          if (answers.second !== undefined) return;
          return { asks: [answers.first !== undefined ? "second" : "first"] };
        },
        async cancelRepair() {
          calls.push("cancelRepair");
        },
      },
    }),
  );
  return { core, calls, attempts, context: () => context };
}

async function foundTv(options: { asks?: string } = {}) {
  const made = setup(options);
  await made.core.start();
  await made.context().devices.found([{ key: "tv", name: "Living Room" }]);
  return made;
}

describe("the suite's adding that asks", () => {
  it("asks each code in turn, then the TV is registered", async () => {
    const { core, calls, attempts } = await foundTv();

    const attempt = await core.startAdd("tv");
    expect(attempt.state).toMatchObject({
      kind: "asking",
      asks: [{ id: "first", kind: "code", length: 4 }],
    });
    await attempt.answer({ first: "1234" });
    expect(attempt.asks[0]).toMatchObject({
      id: "second",
      lasts: { seconds: 35 },
    });
    await attempt.answer({ second: "0042" });

    expect(attempt.state).toEqual({ kind: "done" });
    expect(core.registered.has("tv")).toBe(true);
    expect(calls).toEqual(["add", "add first", "add second"]);
    expect(new Set(attempts)).toEqual(new Set([attempt.id]));
  });

  it("ends after five wrong answers, and the driver closes what it opened", async () => {
    const { core, calls } = await foundTv();
    const attempt = await core.startAdd("tv");

    for (let tries = 0; tries < 5; tries += 1) {
      await attempt.answer({ first: "9999" });
    }

    expect(attempt.state).toEqual({ kind: "ended", why: "wrong" });
    expect(calls.at(-1)).toBe("cancelAdd");
  });

  it("checks a code's digits as the core does", async () => {
    const { core } = await foundTv();
    const attempt = await core.startAdd("tv");

    await expect(attempt.answer({ first: "12a4" })).rejects.toThrow();
    await expect(attempt.answer({ first: "123" })).rejects.toThrow();
  });

  it("asks a code that lasts again, and refuses one after its time", async () => {
    const { core, calls } = await foundTv();
    const attempt = await core.startAdd("tv");
    await attempt.answer({ first: "1234" });

    await attempt.elapse(36_000);
    await expect(attempt.answer({ second: "0042" })).rejects.toThrow();
    await attempt.again("second");

    expect(calls.at(-1)).toBe("add second");
    await attempt.answer({ second: "0042" });
    expect(attempt.state).toEqual({ kind: "done" });
  });

  it("ends as cancel or the time asks, and hands the driver its attempt", async () => {
    const { core, calls, attempts } = await foundTv();
    const cancelled = await core.startAdd("tv");
    await cancelled.cancel();
    const expired = await core.startAdd("tv");
    await expired.elapse(180_000);

    expect(cancelled.state).toEqual({ kind: "ended", why: "cancelled" });
    expect(expired.state).toEqual({ kind: "ended", why: "time" });
    expect(calls.filter((call) => call === "cancelAdd")).toHaveLength(2);
    expect(attempts.at(-1)).toBe(expired.id);
  });

  it("refuses a driver that asks what it doesn't declare for adding", async () => {
    const { core } = await foundTv({ asks: "volume" });

    await expect(core.startAdd("tv")).rejects.toThrow(/doesn't declare/);
    expect(core.refused).toHaveLength(1);
  });

  it("tells a one-shot add that adding asks more", async () => {
    const { core } = await foundTv();

    await expect(core.add("tv")).rejects.toThrow(/startAdd/);
  });
});

describe("the suite's repairing that asks", () => {
  it("asks each code in turn, as the problem's repair declares", async () => {
    const { core, calls, context } = setup();
    await core.start();
    await context().devices.register({
      key: "tv",
      name: "Gym",
      manufacturer: null,
      model: null,
      type: "unknown",
      capabilities: [],
    });
    await context().devices.problem({ key: "tv", problem: "pairingLost" });

    const attempt = await core.startRepair("tv");
    await attempt.answer({ first: "1234" });
    await attempt.answer({ second: "0042" });

    expect(attempt.state).toEqual({ kind: "done" });
    expect(calls).toEqual(["repair", "repair first", "repair second"]);
  });
});

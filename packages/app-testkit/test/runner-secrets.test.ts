import { defineAction } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { createSecretCalls } from "../src/secret-calls.js";
import { createRunnerFixture, statement, testApp } from "./runner-fixture.js";

const fixture = createRunnerFixture();

describe("the conformance core's secrets over the app socket", () => {
  it("keeps a credential through stop and start and replaces and deletes it", async () => {
    let starts = 0;
    const running = await fixture.connected(
      testApp(
        [
          defineAction({
            ...statement("test.runner.replace"),
            async run(ctx) {
              await ctx.secrets.set("device:key", "replaced");
              return ctx.secrets.get("device:key");
            },
          }),
          defineAction({
            ...statement("test.runner.forget"),
            async run(ctx) {
              await ctx.secrets.delete("device:key");
              return ctx.secrets.get("device:key");
            },
          }),
        ],
        {
          async start(ctx) {
            starts += 1;
            if (starts === 1) {
              await ctx.secrets.set("device:key", "first");
            }
            if ((await ctx.secrets.get("device:key")) !== "first") {
              throw new Error("The saved credential was lost");
            }
          },
        },
      ),
      createSecretCalls("test.runner").calls,
    );

    expect(
      await running.call({ kind: "start", reason: "started" }),
    ).toMatchObject({ ok: true });
    expect(
      await running.call({ kind: "stop", reason: "shutdown" }),
    ).toMatchObject({ ok: true });
    expect(
      await running.call({ kind: "start", reason: "started" }),
    ).toMatchObject({ ok: true });
    expect(
      await running.call({
        kind: "action",
        action: "test.runner.replace",
        input: {},
      }),
    ).toEqual({ ok: true, value: "replaced" });
    expect(
      await running.call({
        kind: "action",
        action: "test.runner.forget",
        input: {},
      }),
    ).toEqual({ ok: true, value: null });
  });
});

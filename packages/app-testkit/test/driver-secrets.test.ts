import {
  defineApp,
  maxAppSecrets,
  maxSecretBytes,
  type AppContext,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { createDriverCore } from "../src/index.js";

async function setup() {
  let context!: AppContext;
  const core = createDriverCore(
    defineApp({
      id: "sanctum.example",
      name: "Example",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [],
      actions: [],
      events: [],
      async start(ctx) {
        context = ctx;
      },
    }),
  );
  await core.start();
  return { core, context };
}

describe("the suite's secrets", () => {
  it.each(["get", "delete"] as const)(
    "refuses an invalid name on %s and remembers the refusal",
    async (method) => {
      const { core, context } = await setup();
      const name = "private/name";

      await expect(context.secrets[method](name)).rejects.toThrow(
        "named a secret the core cannot keep",
      );

      expect(core.refused).toHaveLength(1);
      expect(core.refused[0]!.message).not.toContain(name);
    },
  );

  it("keeps secrets across a restart and replaces and deletes them by name", async () => {
    const { core, context } = await setup();
    await context.secrets.set("device:key", "first");
    await core.stop();
    await core.start();
    expect(await context.secrets.get("device:key")).toBe("first");
    await context.secrets.set("device:key", "second");
    expect(core.secrets.get("device:key")).toBe("second");
    await context.secrets.delete("device:key");
    expect(await context.secrets.get("device:key")).toBeNull();
  });

  it("limits values by UTF-8 bytes and permits replacing a secret at capacity", async () => {
    const { core, context } = await setup();
    for (let index = 0; index < maxAppSecrets; index += 1) {
      await context.secrets.set(`device:${index}`, "value");
    }
    await context.secrets.set("device:0", "replaced");
    await expect(context.secrets.set("extra", "value")).rejects.toThrow(
      "secrets already",
    );
    await expect(
      context.secrets.set("device:0", "é".repeat(maxSecretBytes / 2 + 1)),
    ).rejects.toThrow("kept a secret the core cannot keep");
    expect(await context.secrets.get("device:0")).toBe("replaced");
    expect(core.secrets.size).toBe(maxAppSecrets);
    expect(core.refused).toHaveLength(2);
  });
});

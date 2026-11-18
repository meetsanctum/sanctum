import {
  defineAction,
  defineApp,
  toStaticManifest,
} from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { apartApp, uninstallLimitMs } from "../src/app-host/apart.js";
import type { AppLink } from "../src/app-host/link.js";
import { apart, base, running, useCleanUps } from "./app-apart-support.js";
import { fakeManager } from "./manager-support.js";
import { claimed, get, post, testCore } from "./support.js";
import { steps, trigger } from "./workflows-support.js";

// An app's uninstall hook: its last tidying as someone removes it, while it
// still runs, and a removal that goes on whatever it does.

useCleanUps();

async function removed(hooks: {
  uninstall?: () => Promise<void>;
  seen: string[];
}) {
  const { manager } = fakeManager();
  const app = defineApp({
    ...base,
    id: "sanctum.example",
    permissions: [],
    actions: [],
    stop: async () => void hooks.seen.push("stop"),
    ...(hooks.uninstall ? { uninstall: hooks.uninstall } : {}),
  });
  const { core } = await apart(app, { manager });
  await running(core, app.id);
  const maya = await claimed(core);
  const response = await post(core, `/api/apps/${app.id}/remove`, {}, maya);
  return { core, response };
}

describe("an app's uninstall hook", () => {
  it("runs as someone removes it, before it stops", async () => {
    const seen: string[] = [];

    const { core, response } = await removed({
      seen,
      uninstall: async () => void seen.push("uninstall"),
    });

    expect(response.statusCode).toBe(200);
    expect(seen).toEqual(["uninstall", "stop"]);
    expect(core.removedApps.get("sanctum.example")?.isDone).toBe(true);
  });

  it("holds nothing back when it fails", async () => {
    const seen: string[] = [];

    const { core, response } = await removed({
      seen,
      uninstall: async () => {
        throw new Error("the cloud didn't answer");
      },
    });

    expect(response.statusCode).toBe(200);
    expect(seen).toEqual(["stop"]);
    expect(core.removedApps.get("sanctum.example")?.isDone).toBe(true);
    expect(core.logs).toContainEqual(
      expect.stringContaining(
        "sanctum.example didn't tidy up as it was removed",
      ),
    );
  });

  it("finishes removal when its hook runs out of time", async () => {
    const seen: string[] = [];
    const app = defineApp({
      ...base,
      id: "sanctum.example",
      permissions: [],
      actions: [],
      uninstall: async () => {
        seen.push("uninstall");
        await new Promise(() => undefined);
      },
      stop: async () => void seen.push("stop"),
    });
    const { core } = await apart(app);
    await running(core, app.id);
    const maya = await claimed(core);

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const removing = post(core, `/api/apps/${app.id}/remove`, {}, maya);
      await vi.waitFor(() => expect(seen).toEqual(["uninstall"]));
      await vi.advanceTimersByTimeAsync(uninstallLimitMs);

      expect((await removing).statusCode).toBe(200);
      expect(seen).toEqual(["uninstall", "stop"]);
      expect(core.removedApps.get(app.id)?.isDone).toBe(true);
      expect(core.logs).toContain(
        "apps: sanctum.example didn't tidy up as it was removed (timed out)",
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves the installed list before its hook, and stops only after it", async () => {
    const seen: string[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const app = defineApp({
      ...base,
      id: "sanctum.example",
      permissions: [
        { id: "people.read", reason: "To read people", needed: true },
      ],
      actions: [],
      uninstall: async (ctx) => {
        seen.push("uninstall");
        await held;
        await ctx.settings.get();
        seen.push("tidied");
      },
      stop: async () => void seen.push("stop"),
    });
    const { core } = await apart(app);
    await running(core, app.id);
    const maya = await claimed(core);
    const removing = post(core, `/api/apps/${app.id}/remove`, {}, maya);
    try {
      await vi.waitFor(() => expect(seen).toContain("uninstall"));
      expect(core.apps.has(app.id)).toBe(false);
      expect((await get(core, "/api/apps", maya)).json()).toEqual([]);
      expect(
        (
          await post(
            core,
            `/api/apps/${app.id}/permissions/update`,
            { permission: "people.read", granted: false },
            maya,
          )
        ).statusCode,
      ).toBe(404);
      await new Promise((done) => setTimeout(done, 25));
      expect(seen).toEqual(["uninstall"]);
    } finally {
      release();
      await removing;
    }
    expect(seen).toEqual(["uninstall", "tidied", "stop"]);
  });

  it.each(["job", "workflow"])(
    "leaves no %s its uninstall hook scheduled after removal began",
    async (kind) => {
      const action = defineAction({
        id: "sanctum.example.tidy",
        title: "Tidy",
        tier: "write",
        input: z.object({}),
        output: z.unknown(),
        run: async () => undefined,
      });
      const app = defineApp({
        ...base,
        id: "sanctum.example",
        permissions: [{ id: "workflows.manage", reason: "To keep workflows" }],
        actions: [action],
        provides: { steps: [action] },
        uninstall: async (ctx) => {
          if (kind === "job") {
            await ctx.jobs.schedule({
              key: "tidy",
              action,
              input: {},
              when: { at: "2026-10-27T12:00:00Z" },
            });
          } else {
            await ctx.workflows.put("tidy", {
              name: "Tidy",
              graph: steps(trigger("hand", "manual"), {
                id: "tidy",
                kind: "step",
                app: "sanctum.example",
                piece: action.id,
                config: {},
              }),
            });
          }
        },
      });
      const core = await testCore({ apps: [{ app, origin: "official" }] });
      const maya = await claimed(core);

      const response = await post(core, `/api/apps/${app.id}/remove`, {}, maya);

      expect(response.statusCode).toBe(200);
      expect(core.workflows.jobs.list(app.id)).toEqual([]);
      expect(core.workflows.kept.list(app.id)).toEqual([]);
      expect(core.removedApps.get(app.id)?.isDone).toBe(true);
    },
  );

  it("isn't asked of an app built before the call", () => {
    const manifest = toStaticManifest(
      defineApp({
        ...base,
        id: "sanctum.example",
        permissions: [],
        actions: [],
      }),
    );
    const apartOf = (protocol: number) =>
      apartApp(
        { ...manifest, protocol },
        {} as AppLink,
        () => ({}) as never,
        () => 1_000,
        () => undefined,
      );

    expect(apartOf(8).uninstall).toBeUndefined();
    expect(apartOf(9).uninstall).toBeDefined();
  });
});

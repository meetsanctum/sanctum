import { defineApp, toStaticManifest } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { apartApp } from "../src/app-host/apart.js";
import type { AppLink } from "../src/app-host/link.js";
import { apart, base, running, useCleanUps } from "./app-apart-support.js";
import { fakeManager } from "./manager-support.js";
import { claimed, post } from "./support.js";

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

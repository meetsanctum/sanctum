import { defineApp, type AppInfo } from "@meetsanctum/app-sdk";
import { expect, it, vi } from "vitest";

import { base } from "./app-apart-support.js";
import { claimed, get, testCore } from "./support.js";

// The list of the home's apps while the core doesn't know them: it serves
// before its apps' packages are staged, which takes a while after an update,
// and says so, since an empty list would say the home has none.

const lamp = defineApp({
  ...base,
  id: "test.lamp",
  name: "Lamp",
  permissions: [],
  actions: [],
});

it("says it can't list the home's apps until they are installed, then lists them", async () => {
  let stage!: () => void;
  const staged = new Promise<void>((resolve) => (stage = resolve));
  const core = await testCore({
    apps: [{ app: lamp, origin: "official" }],
    staged,
  });
  const maya = await claimed(core);

  // Staged whatever the answer, so the core of a failing test can still stop.
  const early = await get(core, "/api/apps", maya).finally(stage);
  expect(early.statusCode).toBe(503);
  expect(early.json()).toEqual({ error: "unavailable" });

  await vi.waitFor(async () => {
    const listed = await get(core, "/api/apps", maya);
    expect(listed.statusCode).toBe(200);
    expect(listed.json<AppInfo[]>().map((app) => app.id)).toEqual([
      "test.lamp",
    ]);
  });
});

it("lists no apps for a home that has none", async () => {
  const core = await testCore();
  const maya = await claimed(core);
  const listed = await get(core, "/api/apps", maya);
  expect(listed.statusCode).toBe(200);
  expect(listed.json()).toEqual([]);
});

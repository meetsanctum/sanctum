import { describe, expect, it, vi } from "vitest";

import { ActionCallError } from "../src/app-host/errors.js";
import type { Principal } from "../src/auth/clients.js";
import { maxPins, pinRules } from "../src/pins/pins.js";
import { openLive, personWithClient } from "./devices-support.js";
import {
  claimed,
  get,
  post,
  sharedClient,
  testCore,
  type TestCore,
} from "./support.js";

// Pinned apps: the household's, at the top of the sidebar in their order. Every
// client reads and changes them, shared ones included, always the whole list at
// once, and the activity log records nothing.

async function home() {
  const core = await testCore();
  const maya = await claimed(core);
  const update = async (apps: unknown, call: { token: string } = maya) =>
    post(core, "/api/pins/update", { apps }, call);
  return { core, maya, update };
}

const seenBy = async (core: TestCore, token: string) =>
  (await get(core, "/api/pins", { token })).json();

describe("pinned apps", () => {
  it("start empty", async () => {
    const { core, maya } = await home();

    expect(await seenBy(core, maya.token)).toEqual([]);
  });

  it("are stored in the order given, and kept on the next start", async () => {
    const { core, maya, update } = await home();
    const entries = core.activity.recent();

    const pinned = await update([
      "sanctum.settings",
      "moods",
      "sanctum.automations",
    ]);
    const next = await testCore({ dataDir: core.dataDir });

    expect(pinned.statusCode).toBe(200);
    expect(pinned.json()).toEqual([
      "sanctum.settings",
      "moods",
      "sanctum.automations",
    ]);
    expect(await seenBy(core, maya.token)).toEqual(pinned.json());
    expect(next.pins.list()).toEqual(pinned.json());
    // Pinning arranges the sidebar; nothing happened in the home.
    expect(core.activity.recent()).toEqual(entries);
  });

  it("are replaced whole by the next update, to unpin and reorder", async () => {
    const { core, maya, update } = await home();
    await update(["weather", "moods", "sanctum.settings"]);

    const reordered = await update(["sanctum.settings", "weather"]);
    const cleared = await update([]);

    expect(reordered.json()).toEqual(["sanctum.settings", "weather"]);
    expect(cleared.json()).toEqual([]);
    expect(await seenBy(core, maya.token)).toEqual([]);
  });

  it("refuse an app twice, too many apps and malformed ids", async () => {
    const { core, maya, update } = await home();
    await update(["moods"]);

    for (const apps of [
      ["moods", "weather", "moods"],
      Array.from({ length: maxPins + 1 }, (_, at) => `app-${at}`),
      [""],
      ["x".repeat(65)],
      [42],
      "moods",
    ]) {
      const refused = await update(apps);
      expect(refused.statusCode).toBe(400);
      expect(refused.json()).toEqual({ error: "invalid_request" });
    }
    expect((await post(core, "/api/pins/update", {}, maya)).statusCode).toBe(
      400,
    );
    expect(await seenBy(core, maya.token)).toEqual(["moods"]);
  });

  it(`take up to ${maxPins}`, async () => {
    const { update } = await home();
    const apps = Array.from({ length: maxPins }, (_, at) => `app-${at}`);

    expect((await update(apps)).json()).toEqual(apps);
  });

  it("are read and changed by every client, shared ones included", async () => {
    const { core, maya, update } = await home();
    const callers = [sharedClient(core), personWithClient(core, "Ben")];

    for (const [at, { token }] of callers.entries()) {
      const pinned = await update(["moods", `app-${at}`], { token });

      expect(pinned.json()).toEqual(["moods", `app-${at}`]);
      expect(await seenBy(core, token)).toEqual(await seenBy(core, maya.token));
    }
    expect((await get(core, "/api/pins")).statusCode).toBe(401);
    expect(
      (await post(core, "/api/pins/update", { apps: [] })).statusCode,
    ).toBe(401);
  });

  it("are kept from widget tokens", async () => {
    const { core } = await home();
    const widgets: Principal = {
      client: { id: "kitchen", kind: "shared", name: "Kitchen tablet" },
      scope: "widgets",
    };

    for (const rule of [pinRules.read, pinRules.change]) {
      expect(() => core.gate.admit(widgets, rule)).toThrow(
        new ActionCallError("forbidden"),
      );
    }
  });

  it("are followed by live clients, shared ones too", async () => {
    const { core, maya, update } = await home();
    const mine = await openLive(core, maya.token);
    const shared = await openLive(core, sharedClient(core).token);

    await update(["sanctum.settings", "moods"]);

    // Messages arrive over the socket after the request has answered.
    for (const live of [mine, shared]) {
      await vi.waitFor(() =>
        expect(live.messages).toEqual([
          { type: "pins", apps: ["sanctum.settings", "moods"] },
        ]),
      );
      live.socket.terminate();
    }
  });
});

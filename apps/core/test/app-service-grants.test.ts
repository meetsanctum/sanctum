import { defineAction, defineApp, type AppInfo } from "@meetsanctum/app-sdk";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createActivity } from "../src/activity/activity.js";
import type { AppPackage } from "./runner-apps.js";
import { openLive } from "./devices-support.js";
import {
  claimed,
  fakeManager,
  post,
  testCore,
  type TestCore,
} from "./support.js";

// The services an app holds follow its grants: the core asks the manager only
// for the ones that are on, a service switched off loses the app's broker
// account before the switch shows it off, and one switched back on gets a new
// login. An app that needs the service pauses meanwhile; one that does without
// it restarts, so no connection outlives the change.

const said: string[] = [];
beforeEach(() => (said.length = 0));

// An app with Zigbee's bridge, which it needs or may do without, and the
// broker account it holds.
function bridge(
  options: {
    needed?: boolean;
    // While set, its stop hook waits for it.
    stopWaits?: Promise<void>;
  } = {},
): AppPackage {
  return {
    origin: "official",
    app: defineApp({
      id: "test.bridge",
      name: "Bridge",
      version: "0.1.0",
      core: "^1.0.0",
      permissions: [
        {
          id: "services:zigbee2mqtt",
          reason: "To talk to your Zigbee devices.",
          needed: options.needed ?? true,
        },
        { id: "places.read", reason: "To know your rooms.", needed: true },
      ],
      events: [],
      actions: [
        defineAction({
          id: "bridge.account",
          title: "Broker account",
          tier: "read",
          input: z.object({}),
          output: z.object({ username: z.string() }),
          async run(ctx) {
            const connection = await ctx.services.connection("zigbee2mqtt");
            return { username: connection.mqtt?.username ?? "" };
          },
        }),
      ],
      async start() {
        said.push("start");
      },
      async stop() {
        said.push("stop");
        await options.stopWaits;
      },
    }),
  };
}

async function bridgeCore(
  pkg: AppPackage,
  options: {
    dataDir?: string;
    fake?: ReturnType<typeof fakeManager>;
  } = {},
) {
  const fake = options.fake ?? fakeManager();
  const core = await testCore({
    apps: [pkg],
    manager: fake.manager,
    dataDir: options.dataDir,
  });
  const maya = await claimed(core);
  return { core, maya, fake };
}

function grant(
  core: TestCore,
  token: string,
  permission: string,
  granted: boolean,
) {
  return post(
    core,
    "/api/apps/test.bridge/permissions/update",
    { permission, granted },
    { token },
  );
}

// A grant is answered, and an app removed or installed again is under way,
// before what they set going has ended, so the tests wait for what they go
// on from, however long a slow runner takes: the app's stop hook has been
// called, or the app installed again is there, its services asked for. One
// installed while the one removed still stops is not there until it has.
const stopCalled = () => expect.poll(() => said.at(-1)).toBe("stop");
const installedAgain = (core: TestCore) =>
  expect
    .poll(() => core.apps.list().map((app) => app.id))
    .toEqual(["test.bridge"]);

// Long enough for a request that must wait to have gone if it did not.
const aMoment = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("a service an app holds", () => {
  it("is asked for only while its permission is on, and released at start while it is off", async () => {
    const first = await bridgeCore(bridge({ needed: false }));
    expect(first.fake.calls).toEqual(["PUT zigbee2mqtt test.bridge"]);
    await grant(first.core, first.maya.token, "services:zigbee2mqtt", false);

    const fake = fakeManager();
    const again = await testCore({
      apps: [bridge({ needed: false })],
      manager: fake.manager,
      dataDir: first.core.dataDir,
    });

    expect(fake.calls).toEqual(["DELETE zigbee2mqtt test.bridge"]);
    // The same data, so Maya's client still signs in.
    expect(
      (
        await post(
          again,
          "/api/apps/test.bridge/actions/bridge.account",
          {},
          first.maya,
        )
      ).statusCode,
    ).toBe(500);
  });

  it("waits for startup cleanup before asking for a newly granted account", async () => {
    const first = await bridgeCore(bridge({ needed: false }));
    await grant(first.core, first.maya.token, "services:zigbee2mqtt", false);
    let finishCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => (finishCleanup = resolve));
    const fake = fakeManager();
    fake.manager.releaseService = async () => cleanup;
    const need = vi.spyOn(fake.manager, "needService");
    const core = await testCore({
      apps: [bridge({ needed: false })],
      manager: fake.manager,
      dataDir: first.core.dataDir,
    });

    await grant(core, first.maya.token, "services:zigbee2mqtt", true);
    await aMoment();
    const callsBeforeCleanup = need.mock.calls.length;
    finishCleanup();
    await vi.waitFor(() => expect(need).toHaveBeenCalledOnce());

    expect(callsBeforeCleanup).toBe(0);
    expect(
      (
        await post(
          core,
          "/api/apps/test.bridge/actions/bridge.account",
          {},
          first.maya,
        )
      ).json(),
    ).toEqual({ username: "test.bridge" });
  });

  it("goes off once the manager has taken the account back, and the app that needs it pauses", async () => {
    const { core, maya, fake } = await bridgeCore(bridge());
    let confirm!: () => void;
    fake.manager.revokeService = async (service, app) => {
      fake.calls.push(`REVOKE ${service} ${app}`);
      await new Promise<void>((resolve) => (confirm = resolve));
    };

    const answered = grant(core, maya.token, "services:zigbee2mqtt", false);
    await vi.waitFor(() =>
      expect(fake.calls).toContain("REVOKE zigbee2mqtt test.bridge"),
    );
    // Not yet off: the app still holds it.
    expect(core.apps.list()[0]).toMatchObject({
      permissions: ["services:zigbee2mqtt", "places.read"],
      state: "running",
    });
    // Another change waits for it.
    expect(
      (await grant(core, maya.token, "places.read", false)).json(),
    ).toEqual({ error: "conflict" });
    confirm();

    expect((await answered).json()).toMatchObject({
      permissions: ["places.read"],
      state: "paused",
    });
    await stopCalled();
    expect(fake.calls).toEqual([
      "PUT zigbee2mqtt test.bridge",
      "REVOKE zigbee2mqtt test.bridge",
    ]);
    expect(said).toEqual(["start", "stop"]);
  });

  it("does not change kept grants after the app was removed during revocation", async () => {
    const { core, maya, fake } = await bridgeCore(bridge());
    let confirm!: () => void;
    const revocation = new Promise<void>((resolve) => (confirm = resolve));
    const revoke = vi
      .spyOn(fake.manager, "revokeService")
      .mockImplementation(() => revocation);
    const answered = grant(core, maya.token, "services:zigbee2mqtt", false);
    await vi.waitFor(() => expect(revoke).toHaveBeenCalledOnce());
    await core.apps.remove("test.bridge");
    confirm();

    expect((await answered).statusCode).toBe(404);
    await core.startApps([bridge()]);
    expect(core.apps.list()[0]?.permissions).toContain("services:zigbee2mqtt");
  });

  it("lets an app installed again ask for it only once the revocation for the one removed has ended", async () => {
    const { core, maya, fake } = await bridgeCore(bridge());
    let confirm!: () => void;
    const revocation = new Promise<void>((resolve) => (confirm = resolve));
    vi.spyOn(fake.manager, "revokeService").mockImplementation(
      async (service, app) => {
        fake.calls.push(`REVOKE ${service} ${app}`);
        await revocation;
      },
    );
    const answered = grant(core, maya.token, "services:zigbee2mqtt", false);
    await vi.waitFor(() =>
      expect(fake.calls).toContain("REVOKE zigbee2mqtt test.bridge"),
    );
    await core.apps.remove("test.bridge");

    const starting = core.startApps([bridge()]);
    await installedAgain(core);
    // Its PUT waits: the late DELETE would erase its login.
    expect(fake.calls).toEqual([
      "PUT zigbee2mqtt test.bridge",
      "REVOKE zigbee2mqtt test.bridge",
      "DELETE zigbee2mqtt test.bridge",
    ]);
    confirm();
    await starting;
    await answered;

    await expect
      .poll(() => fake.calls.at(-1))
      .toBe("PUT zigbee2mqtt test.bridge");
  });

  it("lets an app installed again ask for it only once the one removed has released it", async () => {
    let stopped!: () => void;
    const stopping = new Promise<void>((resolve) => (stopped = resolve));
    const { core, fake } = await bridgeCore(bridge({ stopWaits: stopping }));

    const removing = core.apps.remove("test.bridge");
    await stopCalled();
    const starting = core.startApps([bridge()]);
    await aMoment();
    // Its PUT waits: the removal's DELETE would erase its login.
    expect(fake.calls).toEqual(["PUT zigbee2mqtt test.bridge"]);
    stopped();
    await removing;
    await starting;

    await expect
      .poll(() => fake.calls)
      .toEqual([
        "PUT zigbee2mqtt test.bridge",
        "DELETE zigbee2mqtt test.bridge",
        "PUT zigbee2mqtt test.bridge",
      ]);
  });

  it("stays on when the manager cannot take it back, and says so", async () => {
    const { core, maya, fake } = await bridgeCore(bridge());
    fake.manager.revokeService = async () => {
      throw new Error("The manager did not answer");
    };

    const answered = await grant(
      core,
      maya.token,
      "services:zigbee2mqtt",
      false,
    );

    expect(answered.statusCode).toBe(503);
    expect(answered.json()).toEqual({ error: "unavailable" });
    expect(core.apps.list()[0]).toMatchObject({
      permissions: ["services:zigbee2mqtt", "places.read"],
      state: "running",
    });
    expect(
      createActivity(core.db)
        .recent()
        .filter((entry) => entry.action === "permissions.update"),
    ).toMatchObject([
      {
        outcome: "failed",
        reason: "unavailable",
        subjectId: "services:zigbee2mqtt off",
      },
    ]);
    expect(core.logs.join("\n")).toContain(
      "apps: could not take zigbee2mqtt back from test.bridge (The manager did not answer)",
    );
  });

  it("gets a new login when it is back, and the app starts again", async () => {
    const { core, maya, fake } = await bridgeCore(bridge());
    await grant(core, maya.token, "services:zigbee2mqtt", false);
    await stopCalled();

    const answered = await grant(
      core,
      maya.token,
      "services:zigbee2mqtt",
      true,
    );

    expect((answered.json() as AppInfo).state).toBe("starting");
    await vi.waitFor(() => expect(core.apps.list()[0]?.state).toBe("running"));
    expect(fake.calls).toEqual([
      "PUT zigbee2mqtt test.bridge",
      "REVOKE zigbee2mqtt test.bridge",
      "PUT zigbee2mqtt test.bridge",
    ]);
    expect(said).toEqual(["start", "stop", "start"]);
    expect(
      (
        await post(
          core,
          "/api/apps/test.bridge/actions/bridge.account",
          {},
          maya,
        )
      ).json(),
    ).toEqual({ username: "test.bridge" });
  });

  it("restarts an app that does without it, so no connection outlives the change", async () => {
    const { core, maya } = await bridgeCore(bridge({ needed: false }));

    await grant(core, maya.token, "services:zigbee2mqtt", false);
    // A stop and a start, each through its socket.
    await expect.poll(() => said).toEqual(["start", "stop", "start"]);
    expect(
      (
        await post(
          core,
          "/api/apps/test.bridge/actions/bridge.account",
          {},
          maya,
        )
      ).statusCode,
    ).toBe(500);

    await grant(core, maya.token, "services:zigbee2mqtt", true);
    await expect
      .poll(() => said)
      .toEqual(["start", "stop", "start", "stop", "start"]);
  });

  it("is starting, not running, while it stops for that restart", async () => {
    let stopped!: () => void;
    const stopping = new Promise<void>((resolve) => (stopped = resolve));
    const { core, maya } = await bridgeCore(
      bridge({ needed: false, stopWaits: stopping }),
    );

    await grant(core, maya.token, "services:zigbee2mqtt", false);
    await stopCalled();

    expect(core.apps.list()[0]?.state).toBe("starting");
    expect(core.apps.isRunning("test.bridge")).toBe(false);
    stopped();

    await expect.poll(() => said).toEqual(["start", "stop", "start"]);
    await expect.poll(() => core.apps.list()[0]?.state).toBe("running");
  });
});

describe("a grant given back", () => {
  it("is announced only once the app runs again", async () => {
    const { core, maya } = await bridgeCore(bridge());
    const live = await openLive(core, maya.token);
    await grant(core, maya.token, "places.read", false);
    await stopCalled();

    await grant(core, maya.token, "places.read", true);
    const states = () =>
      live.messages
        .filter((each) => each.type === "app")
        .map((each) => (each.app as AppInfo).state);
    await expect.poll(states).toContain("running");
    // By then it had started again, so a client may call it at once.
    expect(said).toEqual(["start", "stop", "start"]);
    expect(states().slice(0, states().indexOf("running"))).toEqual([
      "paused",
      "starting",
    ]);
  });
});

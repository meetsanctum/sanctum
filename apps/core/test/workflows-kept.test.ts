import type { WorkflowGraph, WorkflowProblem } from "@meetsanctum/app-sdk";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { workflows } from "../src/workflows/schema.js";
import { lampsCore } from "./devices-support.js";
import { get, post, type TestCore } from "./support.js";
import {
  heard,
  keeper,
  bellGraph,
  home,
  call,
  listed,
  type SignedIn,
} from "./workflows-kept-support.js";
import {
  addWorkflow,
  sample,
  noteStep,
  runsOf,
  steps,
  trigger,
} from "./workflows-support.js";

// Workflows an app keeps: Keeper keeps them by its own keys through
// ctx.workflows, from the core's pieces and its own, as Moods keeps what a
// remote's presses do. They run like any workflow while the app is installed
// and its grants cover them, and people change them only through the app.

beforeEach(() => sample.reset());

describe("a workflow an app keeps", () => {
  it("runs like any workflow, and shows as the app's", async () => {
    const { core, maya } = await home();

    const kept = await call(core, maya, "keeper.keep", {
      key: "front-door",
      name: "Front door bell",
      graph: bellGraph("front"),
    });
    expect(kept.statusCode).toBe(200);
    await call(core, maya, "keeper.ring", { bell: "back" });
    await call(core, maya, "keeper.ring", { bell: "front" });
    await core.workflows.settled();

    expect(heard).toEqual(["front"]);
    expect(await listed(core, maya)).toMatchObject([
      {
        id: kept.json().id,
        name: "Front door bell",
        app: "test.keeper",
        appKey: "front-door",
        createdBy: null,
      },
    ]);
    expect((await call(core, maya, "keeper.list", {})).json()).toEqual({
      keys: ["front-door"],
    });
  });

  it("is replaced by its key, keeping its id and runs", async () => {
    const { core, maya } = await home();
    const first = (
      await call(core, maya, "keeper.keep", {
        key: "front-door",
        name: "Front door bell",
        graph: bellGraph("front"),
      })
    ).json();
    await call(core, maya, "keeper.ring", { bell: "front" });
    await core.workflows.settled();

    const again = (
      await call(core, maya, "keeper.keep", {
        key: "front-door",
        name: "Front door bell",
        graph: bellGraph("front", "ding"),
      })
    ).json();
    await call(core, maya, "keeper.ring", { bell: "front" });
    await core.workflows.settled();

    expect(again).toEqual({ id: first.id, version: first.version + 1 });
    expect(heard).toEqual(["front", "ding"]);
    expect(await runsOf(core, maya.token, first.id)).toHaveLength(2);
    expect(await listed(core, maya)).toHaveLength(1);
  });

  it("uses only the core's pieces and the app's own, and only whole graphs", async () => {
    const { core, maya } = await home();

    for (const graph of [
      // Sample's step is another app's.
      steps(trigger("rang", "keeper.rang", {}, "test.keeper"), noteStep("n")),
      // No step.
      { version: 1, nodes: [trigger("t", "manual")], edges: [] },
    ]) {
      expect(
        (
          await call(core, maya, "keeper.keep", {
            key: "odd",
            name: "Odd",
            graph,
          })
        ).json(),
      ).toEqual({ error: "app_failed" });
    }
    expect(await listed(core, maya)).toEqual([]);
  });

  it("changes only through the app, though people may run it", async () => {
    const { core, maya } = await home();
    const { id } = (
      await call(core, maya, "keeper.keep", {
        key: "front-door",
        name: "Front door bell",
        graph: bellGraph("front"),
      })
    ).json();

    for (const [url, body] of [
      ["/api/workflows/update", { id, enabled: false }],
      ["/api/workflows/remove", { id }],
    ] as const) {
      const refused = await post(core, url, body, maya);
      expect(refused.statusCode).toBe(409);
      expect(refused.json()).toEqual({ error: "kept_by_app" });
    }
    const ran = await post(core, "/api/workflows/run", { id }, maya);
    await core.workflows.settled();

    expect(ran.statusCode).toBe(200);
    expect(heard).toEqual(["front"]);
  });

  it("goes when the app removes it, leaving people's own", async () => {
    const { core, maya } = await home();
    await call(core, maya, "keeper.keep", {
      key: "front-door",
      name: "Front door bell",
      graph: bellGraph("front"),
    });
    const own = await addWorkflow(core, maya.token, {
      name: "Mine",
      graph: steps(trigger("t", "manual"), noteStep("n")),
    });

    await call(core, maya, "keeper.drop", { key: "front-door" });
    await call(core, maya, "keeper.drop", { key: "never-kept" });

    expect((await listed(core, maya)).map((each) => each.id)).toEqual([own.id]);
  });

  it("waits while its app is removed", async () => {
    const { core, maya } = await home([lightsKeeper()]);
    // At 12:01 the home's lights go off, with the core's own pieces only.
    await call(core, maya, "keeper.keep", {
      key: "lights-out",
      name: "Lights out",
      graph: steps(trigger("at", "time", { time: "12:01" }), {
        id: "off",
        kind: "step",
        piece: "lights",
        config: { place: { kind: "home" }, to: "off" },
      }),
    });
    const [kept] = await listed(core, maya);

    await core.apps.remove("test.keeper");
    core.advance(2 * 60_000);
    core.workflows.tick();
    await core.workflows.settled();

    expect(await runsOf(core, maya.token, kept!.id)).toEqual([]);
    const manual = await post(
      core,
      "/api/workflows/run",
      { id: kept!.id },
      maya,
    );
    expect(manual.statusCode).toBe(400);
    expect(manual.json().error).toBe("invalid_workflow");
    expect(await runsOf(core, maya.token, kept!.id)).toEqual([]);
  });

  it("needs workflows.manage", async () => {
    const { core, maya } = await home([keeper([])]);

    expect(
      (
        await call(core, maya, "keeper.keep", {
          key: "front-door",
          name: "Front door bell",
          graph: bellGraph("front"),
        })
      ).json(),
    ).toEqual({ error: "app_failed" });
    expect(core.logs.join("\n")).toContain(
      "test.keeper does not hold workflows.manage",
    );
  });
});

// At 12:01 the home's lights go off: the core's lights step, which needs
// devices.control:light.
const lightsOut = steps(trigger("at", "time", { time: "12:01" }), {
  id: "off",
  kind: "step",
  piece: "lights",
  config: { place: { kind: "home" }, to: "off" },
});
const lightsKeeper = () =>
  keeper(["workflows.manage", "devices.control:light"]);

function grant(
  core: TestCore,
  maya: SignedIn,
  permission: string,
  granted: boolean,
) {
  return post(
    core,
    "/api/apps/test.keeper/permissions/update",
    { permission, granted },
    maya,
  );
}

async function suspensionOf(core: TestCore, maya: SignedIn, id: string) {
  const all = (await get(core, "/api/workflows", maya)).json() as {
    id: string;
    suspended: WorkflowProblem[];
  }[];
  return all.find((workflow) => workflow.id === id)!.suspended;
}

describe("a workflow an app keeps, with the app's grants", () => {
  it("is refused when the app may not do what its pieces do", async () => {
    const { core, maya } = await home();

    const kept = await call(core, maya, "keeper.keep", {
      key: "lights-out",
      name: "Lights out",
      graph: lightsOut,
    });

    expect(kept.json()).toEqual({ error: "app_failed" });
    expect(core.logs.join("\n")).toContain(
      "test.keeper's workflow lights-out goes beyond what it holds: test.keeper does not hold devices.control:light",
    );
    expect(await listed(core, maya)).toEqual([]);
  });

  it("is refused for an app that is no longer installed", async () => {
    const { core, maya } = await home([lightsKeeper()]);
    await core.apps.remove("test.keeper");

    expect(() =>
      core.workflows.kept.put("test.keeper", {
        key: "lights-out",
        name: "Lights out",
        graph: lightsOut,
      }),
    ).toThrow("test.keeper is not installed");
    expect(await listed(core, maya)).toEqual([]);
  });

  it("is suspended while a permission it needs is off, unchanged, and runs again once it is back", async () => {
    const { core, maya } = await home([lightsKeeper()]);
    await call(core, maya, "keeper.keep", {
      key: "lights-out",
      name: "Lights out",
      graph: lightsOut,
    });
    const [kept] = await listed(core, maya);

    await grant(core, maya, "devices.control:light", false);
    core.advance(2 * 60_000);
    core.workflows.tick();
    await core.workflows.settled();

    expect(await runsOf(core, maya.token, kept!.id)).toEqual([]);
    // It says what the app lacks, so Automations can name it.
    expect(await suspensionOf(core, maya, kept!.id)).toEqual([
      expect.objectContaining({
        message: "test.keeper does not hold devices.control:light",
        permission: "devices.control:light",
      }),
    ]);
    const byHand = await post(
      core,
      "/api/workflows/run",
      { id: kept!.id },
      maya,
    );
    expect(byHand.json()).toMatchObject({
      status: "skipped",
      reason: "suspended",
      error: "test.keeper does not hold devices.control:light",
      steps: [],
    });
    expect((await listed(core, maya))[0]).toMatchObject({
      id: kept!.id,
      version: kept!.version,
    });

    await grant(core, maya, "devices.control:light", true);
    const again = (
      await post(core, "/api/workflows/run", { id: kept!.id }, maya)
    ).json();
    await core.workflows.settled();
    expect(core.workflows.run(again.id)).toMatchObject({
      steps: [expect.objectContaining({ node: "off" })],
    });
    expect(await suspensionOf(core, maya, kept!.id)).toEqual([]);
  });

  it("is suspended while the app may not keep workflows", async () => {
    const { core, maya } = await home();
    await call(core, maya, "keeper.keep", {
      key: "front-door",
      name: "Front door bell",
      graph: bellGraph("front"),
    });

    await grant(core, maya, "workflows.manage", false);
    await call(core, maya, "keeper.ring", { bell: "front" });
    await core.workflows.settled();
    expect(heard).toEqual([]);

    await grant(core, maya, "workflows.manage", true);
    await call(core, maya, "keeper.ring", { bell: "front" });
    await core.workflows.settled();
    expect(heard).toEqual(["front"]);
  });

  it.each(["workflows.manage", "devices.control:light", "removed", "paused"])(
    "refuses later steps when access changes during a run (%s)",
    async (change) => {
      const { core, maya, lamp } = await lampsCore({
        apps: [
          keeper(
            ["workflows.manage", "devices.control:light", "places.read"],
            "places.read",
          ),
        ],
      });
      heard.length = 0;
      const release = sample.holdSteps();
      const { id } = (
        await call(core, maya, "keeper.keep", {
          key: "held",
          name: "Held",
          graph: steps(
            trigger("t", "manual"),
            {
              id: "wait",
              kind: "step",
              app: "test.keeper",
              piece: "keeper.listen",
              config: { text: "waiting" },
            },
            {
              id: "on",
              kind: "step",
              piece: "device",
              config: {
                device: lamp,
                capability: "light",
                command: { on: true },
              },
            },
            {
              id: "listen",
              kind: "step",
              app: "test.keeper",
              piece: "keeper.listen",
              config: { text: "after" },
            },
          ),
        })
      ).json();
      await post(core, "/api/workflows/run", { id }, maya);
      let removing: Promise<void> | undefined;
      try {
        await vi.waitFor(() => expect(heard).toEqual(["waiting"]));
        if (change === "removed") {
          removing = core.apps.remove("test.keeper");
        } else {
          await grant(
            core,
            maya,
            change === "paused" ? "places.read" : change,
            false,
          );
        }
      } finally {
        release();
      }
      await removing;
      await core.workflows.settled();

      const [run] = await runsOf(core, maya.token, id);
      expect(run!.steps.find((step) => step.node === "on")).toMatchObject({
        status: "failed",
      });
      expect(core.devices.get(lamp)!.capabilities[0]!.desired).toBeNull();
      if (change === "workflows.manage") {
        expect(heard).toEqual(["waiting"]);
        expect(run!.steps.find((step) => step.node === "listen")).toMatchObject(
          {
            status: "failed",
            error: "test.keeper does not hold workflows.manage",
          },
        );
      }
    },
  );

  it("suspends a stored device trigger that could read across ungranted kinds", async () => {
    const { core, maya } = await home();
    const { id } = await addWorkflow(core, maya.token, {
      graph: steps(trigger("changed", "device", { capability: "light" }), {
        id: "listen",
        kind: "step",
        app: "test.keeper",
        piece: "keeper.listen",
        config: { text: "changed" },
      }),
    });
    // A graph kept before grants were enforced: the trigger schema lets
    // it name a capability across devices, whose kinds may differ.
    core.db
      .update(workflows)
      .set({ app: "test.keeper", appKey: "device" })
      .where(eq(workflows.id, id))
      .run();

    const listed = await get(core, "/api/workflows", maya);
    expect(listed.statusCode).toBe(200);
    // No permission would cover it.
    expect(listed.json()[0].suspended).toEqual([
      {
        node: expect.any(String),
        field: null,
        message: "test.keeper's device trigger must name a device",
      },
    ]);
    const run = await post(core, "/api/workflows/run", { id }, maya);
    expect(run.json()).toMatchObject({
      status: "skipped",
      reason: "suspended",
    });
  });

  it("reaches only the devices' capabilities the app may read and control", async () => {
    heard.length = 0;
    const { core, maya, lamp, plug } = await lampsCore({
      apps: [keeper(["workflows.manage", "devices.read:light"])],
    });
    const listen = {
      id: "listen",
      kind: "step" as const,
      app: "test.keeper",
      piece: "keeper.listen",
      config: { text: "changed" },
    };
    const keep = (graph: WorkflowGraph) =>
      call(core, maya, "keeper.keep", { key: "device", name: "Device", graph });

    expect(
      (
        await keep(
          steps(
            trigger("changed", "device", { device: lamp, capability: "light" }),
            listen,
          ),
        )
      ).statusCode,
    ).toBe(200);
    for (const graph of [
      // The plug's power is a switch, which Keeper may not read.
      steps(
        trigger("changed", "device", { device: plug, capability: "power" }),
        listen,
      ),
      // A capability id without its device could match any kind.
      steps(trigger("changed", "device", { capability: "power" }), listen),
      // A whole device would reach what Keeper may not read.
      steps(trigger("changed", "device", { device: lamp }), listen),
      // A capability the lamp does not have has no kind to check.
      steps(
        trigger("changed", "device", { device: lamp, capability: "dimmer" }),
        listen,
      ),
      // Reading lights is not controlling them.
      steps(trigger("t", "manual"), {
        id: "on",
        kind: "step",
        piece: "device",
        config: { device: lamp, capability: "light", command: { on: true } },
      }),
    ]) {
      expect((await keep(graph)).json()).toEqual({ error: "app_failed" });
    }
    expect(core.logs.join("\n")).toMatch(
      /does not hold devices\.read:switch[\s\S]*must name a device[\s\S]*must name a capability[\s\S]*names a capability its device does not have[\s\S]*does not hold devices\.control:light/,
    );
  });
});

describe("an entity's piece in a workflow an app keeps", () => {
  const sunGraph = steps(trigger("sun", "entity", { type: "sun" }), {
    id: "listen",
    kind: "step",
    app: "test.keeper",
    piece: "keeper.listen",
    config: { text: "sun" },
  });

  it("reaches other apps' entities of a type only with the permission to read it", async () => {
    const without = await home();
    expect(
      (
        await call(without.core, without.maya, "keeper.keep", {
          key: "sun",
          name: "Sun",
          graph: sunGraph,
        })
      ).json(),
    ).toEqual({ error: "app_failed" });
    expect(without.core.logs.join("\n")).toContain(
      "test.keeper does not hold entities.read:sun",
    );

    const reads = await home([
      keeper(["workflows.manage", "entities.read:sun"]),
    ]);
    expect(
      (
        await call(reads.core, reads.maya, "keeper.keep", {
          key: "sun",
          name: "Sun",
          graph: sunGraph,
        })
      ).statusCode,
    ).toBe(200);
  });

  it("reaches the app's own entities without one", async () => {
    const { core, maya } = await home();

    const kept = await call(core, maya, "keeper.keep", {
      key: "own",
      name: "Own",
      graph: steps(
        trigger("own", "entity", { app: "test.keeper", key: "porch" }),
        {
          id: "listen",
          kind: "step",
          app: "test.keeper",
          piece: "keeper.listen",
          config: { text: "porch" },
        },
      ),
    });

    expect(kept.statusCode).toBe(200);
  });
});

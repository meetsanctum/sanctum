import { beforeEach, describe, expect, it, vi } from "vitest";

import { durably } from "../src/database.js";
import { post } from "./support.js";
import { heard, home, call, listed } from "./workflows-kept-support.js";
import { sample, steps, trigger } from "./workflows-support.js";

// Removing a workflow an app keeps, by its own call or an update's commit: its run ends
// rather than carry on against deleted records.

beforeEach(() => sample.reset());

describe("an update's commit removing a workflow an app keeps", () => {
  const waiting = async () => {
    const { core, maya } = await home();
    const release = sample.holdSteps();
    const listen = (id: string) => ({
      id,
      kind: "step" as const,
      app: "test.keeper",
      piece: "keeper.listen",
      config: { text: id },
    });
    const { id } = (
      await call(core, maya, "keeper.keep", {
        key: "going",
        name: "Going",
        graph: steps(trigger("t", "manual"), listen("first"), listen("second")),
      })
    ).json();
    heard.length = 0;
    await post(core, "/api/workflows/run", { id }, { token: maya.token });
    await vi.waitFor(() => expect(heard).toEqual(["first"]));
    return { core, release, maya };
  };

  it("leaves its run going if the transaction fails", async () => {
    const { core, release, maya } = await waiting();

    expect(() =>
      durably(core.db, () => {
        core.workflows.kept.sweep("test.keeper", new Set());
        throw new Error("The disk is full");
      }),
    ).toThrow("The disk is full");
    expect(await listed(core, maya)).toHaveLength(1);
    release();
    await core.workflows.settled();

    expect(heard).toEqual(["first", "second"]);
  });

  it("ends its run once the transaction has committed", async () => {
    const { core, release, maya } = await waiting();

    const endRuns = durably(core.db, () =>
      core.workflows.kept.sweep("test.keeper", new Set()),
    );
    expect(await listed(core, maya)).toEqual([]);
    endRuns();
    release();
    await core.workflows.settled();

    expect(heard).toEqual(["first"]);
  });

  it("keeps what it claimed, and its run", async () => {
    const { core, release, maya } = await waiting();

    durably(core.db, () =>
      core.workflows.kept.sweep("test.keeper", new Set(["going"])),
    )();
    release();
    await core.workflows.settled();

    expect(await listed(core, maya)).toHaveLength(1);
    expect(heard).toEqual(["first", "second"]);
  });
});

describe("removing a workflow an app keeps", () => {
  it("leaves its run going if the removal fails", async () => {
    const { core, maya } = await home();
    const release = sample.holdSteps();
    const listen = (id: string) => ({
      id,
      kind: "step" as const,
      app: "test.keeper",
      piece: "keeper.listen",
      config: { text: id },
    });
    const { id } = (
      await call(core, maya, "keeper.keep", {
        key: "going",
        name: "Going",
        graph: steps(trigger("t", "manual"), listen("first"), listen("second")),
      })
    ).json();
    heard.length = 0;
    await post(core, "/api/workflows/run", { id }, { token: maya.token });
    await vi.waitFor(() => expect(heard).toEqual(["first"]));
    core.db.$client.exec(`
      CREATE TRIGGER refuse_removal BEFORE DELETE ON workflows
      BEGIN SELECT RAISE(ABORT, 'It could not be removed'); END;
    `);

    expect(() => core.workflows.kept.remove("test.keeper", "going")).toThrow(
      "It could not be removed",
    );
    core.db.$client.exec("DROP TRIGGER refuse_removal");
    release();
    await core.workflows.settled();

    expect(heard).toEqual(["first", "second"]);
  });

  it("ends its run still under way, rather than carry on against deleted records", async () => {
    const { core, maya } = await home();
    const release = sample.holdSteps();
    const listen = (id: string) => ({
      id,
      kind: "step" as const,
      app: "test.keeper",
      piece: "keeper.listen",
      config: { text: id },
    });
    const { id } = (
      await call(core, maya, "keeper.keep", {
        key: "going",
        name: "Going",
        graph: steps(trigger("t", "manual"), listen("first"), listen("second")),
      })
    ).json();
    heard.length = 0;
    const started = await post(
      core,
      "/api/workflows/run",
      { id },
      { token: maya.token },
    );
    expect(started.statusCode).toBe(200);
    await vi.waitFor(() => expect(heard).toEqual(["first"]));

    await call(core, maya, "keeper.drop", { key: "going" });
    release();
    await core.workflows.settled();

    expect(heard).toEqual(["first"]);
    expect(core.logs.join()).not.toContain("FOREIGN KEY");
  });
});

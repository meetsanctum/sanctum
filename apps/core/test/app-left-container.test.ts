import { describe, expect, it, vi } from "vitest";

import { useCleanUps } from "./app-apart-support.js";
import { id, version, type Seen } from "./app-update-fixtures.js";
import { running, stateOf, versions } from "./app-update-support.js";
import type { TestCore } from "./support.js";

// A core stopped just after starting an app's container leaves one still trying its
// socket, which then reaches the next core. That core replaces it as it starts any,
// so it isn't started, and its going isn't a failure of the app.

useCleanUps();

const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("a container a core before this one left", () => {
  it("isn't started, and goes without counting as a failure", async () => {
    const home = await versions();
    const seen: Seen = [];
    const app = version("1.0.0", { seen });
    const before = await home.coreWith(app);
    await running(before, id);
    await before.apps.close();
    await home.stopContainer();
    seen.length = 0;
    home.containers.length = 0;
    const reached = new Promise<void>((done) => {
      home.runContainer(app, done);
    });
    let replace!: () => void;
    const replacing = new Promise<void>((done) => {
      replace = done;
    });
    const start = home.manager.startAppContainer;
    home.manager.startAppContainer = async (...args) => {
      await replacing;
      await home.stopContainer();
      // Docker's removal is long done when the manager answers, so the core has heard.
      await vi.waitFor(() =>
        expect(core.logs.join()).toContain("connection ended"),
      );
      return start(...args);
    };

    const core: TestCore = await home.coreWith(app);
    await reached;
    await pause(100);
    expect(seen).toEqual([]);
    expect(stateOf(core, id).state).toBe("starting");
    replace();

    await running(core, id);
    expect(seen).toHaveLength(1);
    expect(home.containers).toHaveLength(1);
    expect(stateOf(core, id).run?.failures).toBeFalsy();
    expect(stateOf(core, id).run?.lastFailure).toBeUndefined();
  });

  it("starts one that says hello before the manager has answered", async () => {
    const home = await versions();
    const seen: Seen = [];
    const app = version("1.0.0", { seen });
    let asked = 0;
    home.manager.startAppContainer = async () => {
      asked += 1;
      // Waiting for the manager, as well as starting.
      if (asked === 1) throw new Error("The manager isn't there just now");
      await new Promise<void>((done) => {
        home.runContainer(app, done);
      });
      await pause(100);
      return { kept: false };
    };

    const core = await home.coreWith(app);

    await running(core, id);
    expect(seen).toHaveLength(1);
    expect(asked).toBe(2);
  });

  it("still counts one that goes once its replacement has started", async () => {
    const home = await versions();
    const app = version("1.0.0");
    const core = await home.coreWith(app);
    await running(core, id);

    await home.stopContainer();

    await vi.waitFor(() => expect(stateOf(core, id).run?.failures).toBe(1));
    await running(core, id);
  });
});

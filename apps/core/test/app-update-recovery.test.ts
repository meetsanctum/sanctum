import { describe, expect, it, vi } from "vitest";

import { useCleanUps } from "./app-apart-support.js";
import { id, version } from "./app-update-fixtures.js";
import { running, stateOf, versions } from "./app-update-support.js";

// An app with no update of its own, as a core starts while the manager is
// away: after a core's update the manager is replaced, and meanwhile nothing
// of an app's update can be recovered, so the app waits.

useCleanUps();

describe("an app that waited for the manager to come back", () => {
  it("is started in the container it goes on in, though it said hello before the manager answered", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);

    let answering = false;
    const list = home.manager.appUpdates;
    home.manager.appUpdates = async () => {
      if (!answering) throw new Error("The manager did not answer");
      return list();
    };
    // The manager keeps its container, and takes longer to say so than the
    // app takes to find this core: a runner looks every quarter of a second.
    const start = home.manager.startAppContainer;
    home.manager.startAppContainer = async (app, spec) => {
      const kept = await start(app, spec);
      await new Promise((done) => setTimeout(done, 700));
      return kept;
    };

    const core = await home.coreWith(version("1.0.0"));
    await vi.waitFor(() => expect(stateOf(core, id).state).toBe("waiting"));
    expect(stateOf(core, id).run?.waitingFor).toBe(
      "Waiting for its data to come back",
    );

    answering = true;
    await running(core, id);

    // The same container throughout.
    expect(home.containers).toEqual(["1.0.0+test"]);
    expect(stateOf(core, id).run?.waitingFor).toBeUndefined();
  });
});

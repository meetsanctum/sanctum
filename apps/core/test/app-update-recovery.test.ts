import { describe, expect, it, vi } from "vitest";

import * as appLinks from "../src/app-host/link.js";
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

    let isAnswering = false;
    const list = home.manager.appUpdates;
    home.manager.appUpdates = async () => {
      if (!isAnswering) throw new Error("The manager did not answer");
      return list();
    };
    let resolveRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      resolveRequested = resolve;
    });
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    // Deliver readiness during the container request, then let the manager
    // answer. The runner's reconnect timing cannot change that order.
    const createLink = appLinks.createAppLink;
    const creating = vi
      .spyOn(appLinks, "createAppLink")
      .mockImplementation((options) =>
        createLink({
          ...options,
          async onReady() {
            await requested;
            options.onReady();
            resolveReady();
          },
        }),
      );
    const start = home.manager.startAppContainer;
    home.manager.startAppContainer = async (app, spec) => {
      const kept = await start(app, spec);
      resolveRequested();
      await ready;
      return kept;
    };

    try {
      const core = await home.coreWith(version("1.0.0"));
      await vi.waitFor(() => expect(stateOf(core, id).state).toBe("waiting"));
      expect(stateOf(core, id).run?.waitingFor).toBe(
        "Waiting for its data to come back",
      );

      isAnswering = true;
      await running(core, id);

      // The same container throughout.
      expect(home.containers).toEqual(["1.0.0+test"]);
      expect(stateOf(core, id).run?.waitingFor).toBeUndefined();
    } finally {
      resolveRequested();
      resolveReady();
      creating.mockRestore();
    }
  });
});

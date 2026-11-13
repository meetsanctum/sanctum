import { describe, expect, it, vi } from "vitest";

import { useCleanUps } from "./app-apart-support.js";
import { id, version, type Seen } from "./app-update-fixtures.js";
import {
  committedOf,
  running,
  stateOf,
  versions,
} from "./app-update-support.js";

// An app's update while the manager's slot is taken: it waits for its turn and
// asks again by itself, whatever of the app still runs meanwhile.

useCleanUps();

describe("an update that waits for its turn", () => {
  it("waits for its turn while the manager's slot is taken, not counting it", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    let busy = true;
    const begin = home.manager.beginAppUpdate;
    home.manager.beginAppUpdate = async (app, request) => {
      if (busy) throw new Error("HTTP 409: An update is already running");
      await begin(app, request);
    };

    const core = await home.coreWith(version("2.0.0"));
    await vi.waitFor(() => expect(stateOf(core, id).state).toBe("waiting"));
    expect(stateOf(core, id).run?.waitingFor).toBe(
      "Waiting for its turn to update",
    );
    expect(stateOf(core, id).run?.failures).toBeUndefined();

    busy = false;
    await running(core, id);

    expect(committedOf(core)?.version).toBe("2.0.0");
  });

  it("asks again for a new build of the same version, though the one before goes on in its container meanwhile", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    let busy = true;
    const begin = home.manager.beginAppUpdate;
    home.manager.beginAppUpdate = async (app, request) => {
      if (busy) throw new Error("HTTP 409: An update is already running");
      await begin(app, request);
    };

    // The build before still runs, and says hello to this core as itself:
    // its version and manifest are the new build's.
    const seen: Seen = [];
    const core = await home.coreWith(version("1.0.0", { seen }), {
      folder: "1.0.0+rebuilt",
    });
    await vi.waitFor(() => expect(stateOf(core, id).state).toBe("waiting"));
    // A runner looks for the next core every quarter of a second.
    await new Promise((done) => setTimeout(done, 700));
    expect(stateOf(core, id).state).toBe("waiting");
    expect(home.containers).toEqual(["1.0.0+test"]);

    busy = false;
    await running(core, id);

    expect(home.containers).toEqual(["1.0.0+test", "1.0.0+rebuilt"]);
    expect(seen).toEqual([{ reason: "updated", from: "1.0.0" }]);
    expect(committedOf(core)?.folder).toBe("1.0.0+rebuilt");
  });
});

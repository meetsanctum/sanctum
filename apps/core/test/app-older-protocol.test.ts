import { describe, expect, it, vi } from "vitest";

import { useCleanUps } from "./app-apart-support.js";
import { id, version } from "./app-update-fixtures.js";
import {
  committedOf,
  rowOf,
  running,
  stateOf,
  versions,
} from "./app-update-support.js";
import { claimed, get, post } from "./support.js";

// An app's versions built for a protocol before this core's, as a core's update
// that changes the protocol leaves them kept: the core can't run them, so it never
// goes back to one, and starts the version its image brings instead.

useCleanUps();

const speaksOlder = (from: string) =>
  `apps: ${id} ${from} speaks a protocol this core doesn't`;

describe("a version from before this core's protocol", () => {
  it("isn't offered to go back to, and going back to it is refused before anything stops", async () => {
    const home = await versions();
    const one = version("1.0.0");
    await running(await home.coreWith(one), id);
    const core = await home.coreWith(version("2.0.0"));
    await running(core, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    home.builtForAnOlderProtocol(one);
    const maya = await claimed(core);
    const kept = await home.manager.keptAppCopy(id);
    home.containers.length = 0;

    const offered = await get(core, `/api/apps/${id}/go-back`, maya);
    const pressed = await post(
      core,
      `/api/apps/${id}/go-back`,
      { id: kept!.id },
      maya,
    );

    expect(offered.json()).toEqual({ to: null });
    expect(pressed.statusCode).toBe(409);
    expect(core.logs).toContain(`${speaksOlder("1.0.0")}, so it can't go back`);
    expect(rowOf(core)).toBeUndefined();
    expect(home.containers).toEqual([]);
    expect(stateOf(core, id)).toMatchObject({
      state: "running",
      version: "2.0.0",
    });
  });

  it("isn't where an update cut short goes back to: the version the core brings starts", async () => {
    const home = await versions();
    const one = version("1.0.0");
    await running(await home.coreWith(one), id);
    const core = await home.coreWith(
      version("2.0.0", { start: () => new Promise(() => undefined) }),
    );
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("starting"));
    await home.powerCut(core);
    home.builtForAnOlderProtocol(one);
    home.containers.length = 0;

    const next = await home.coreWith(version("2.0.0"));

    await running(next, id);
    expect(next.logs).toContain(
      `${speaksOlder("1.0.0")}, so it starts on 2.0.0`,
    );
    await vi.waitFor(() => expect(committedOf(next)?.version).toBe("2.0.0"));
    expect(rowOf(next)).toBeUndefined();
    expect(home.containers).not.toContain("1.0.0+test");
  });

  it("offers no version until its protocol can be read", async () => {
    const home = await versions();
    await running(await home.coreWith(version("1.0.0")), id);
    const core = await home.coreWith(version("2.0.0"));
    await running(core, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    const maya = await claimed(core);
    home.packagesUnreadableFor(1);

    const offered = await get(core, `/api/apps/${id}/go-back`, maya);
    expect(offered.statusCode).toBe(200);
    expect(offered.json()).toEqual({ to: null });
    const retried = await get(core, `/api/apps/${id}/go-back`, maya);
    expect(retried.json()).toMatchObject({ to: { version: "1.0.0" } });
  });

  it.each([0, 1])(
    "retries a failed new version after %i temporary package read failures",
    async (failedReads) => {
      const home = await versions();
      const one = version("1.0.0");
      await running(await home.coreWith(one), id);
      home.builtForAnOlderProtocol(one);
      home.packagesUnreadableFor(failedReads);
      home.containers.length = 0;
      let tries = 0;

      const core = await home.coreWith(
        version("2.0.0", {
          start: async () => {
            tries += 1;
            if (tries === 1) throw new Error("It fell over");
          },
        }),
      );

      await vi.waitFor(() => expect(committedOf(core)?.version).toBe("2.0.0"));
      await running(core, id);
      expect(tries).toBe(2);
      expect(home.containers).not.toContain("1.0.0+test");
      expect(core.logs.filter((line) => line.includes("goes back"))).toEqual(
        [],
      );
    },
  );
});

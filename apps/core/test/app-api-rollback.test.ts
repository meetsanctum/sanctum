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

useCleanUps();

describe("a kept version built for another app API", () => {
  it("isn't offered or accepted for going back before anything stops", async () => {
    const home = await versions();
    const one = version("1.0.0");
    await running(await home.coreWith(one), id);
    const core = await home.coreWith(version("2.0.0"));
    await running(core, id);
    await vi.waitFor(() => expect(home.journal.size).toBe(0));
    home.builtForAppApi(one, "^2.0.0");
    const principal = await claimed(core);
    const kept = await home.manager.keptAppCopy(id);
    home.containers.length = 0;

    const offered = await get(core, `/api/apps/${id}/go-back`, principal);
    const pressed = await post(
      core,
      `/api/apps/${id}/go-back`,
      { id: kept!.id },
      principal,
    );

    expect(offered.json()).toEqual({ to: null });
    expect(pressed.statusCode).toBe(409);
    expect(rowOf(core)).toBeUndefined();
    expect(home.containers).toEqual([]);
    expect(stateOf(core, id)).toMatchObject({
      state: "running",
      version: "2.0.0",
    });
  });

  it("isn't selected when recovering an update cut short", async () => {
    const home = await versions();
    const one = version("1.0.0");
    await running(await home.coreWith(one), id);
    const core = await home.coreWith(
      version("2.0.0", { start: () => new Promise(() => undefined) }),
    );
    await vi.waitFor(() => expect(rowOf(core)?.status).toBe("starting"));
    await home.powerCut(core);
    home.builtForAppApi(one, "^2.0.0");
    home.containers.length = 0;

    const next = await home.coreWith(version("2.0.0"));

    await running(next, id);
    await vi.waitFor(() => expect(committedOf(next)?.version).toBe("2.0.0"));
    expect(rowOf(next)).toBeUndefined();
    expect(home.containers).not.toContain("1.0.0+test");
  });

  it("isn't selected when the new version fails and can retry", async () => {
    const home = await versions();
    const one = version("1.0.0");
    await running(await home.coreWith(one), id);
    home.builtForAppApi(one, "^2.0.0");
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
  });
});

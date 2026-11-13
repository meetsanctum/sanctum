import type { AppRunning } from "@meetsanctum/app-sdk";
import { describe, expect, it, vi } from "vitest";

import { useCleanUps } from "./app-apart-support.js";
import { id, version } from "./app-update-fixtures.js";
import {
  running as isRunning,
  stateOf,
  versions,
} from "./app-update-support.js";
import { claimed, get, type TestCore } from "./support.js";

// How it's running, which an app's settings show: what the manager reads for one in
// its own container, and what its supervisor keeps.

useCleanUps();

const usage = { memoryBytes: 40_000_000, processor: 0.4, dataBytes: 9_000_000 };

const read = async (core: TestCore) => {
  const { token } = await claimed(core);
  const answer = await get(core, `/api/apps/${id}/running`, { token });
  expect(answer.statusCode).toBe(200);
  return answer.json<{ running: AppRunning | null }>().running;
};

describe("how an app is running", () => {
  it("gives what the manager reads for its container", async () => {
    const home = await versions();
    home.manager.appUsage = async () => usage;
    const core = await home.coreWith(version("1.0.0"));
    await isRunning(core, id);

    expect(await read(core)).toEqual({
      ...usage,
      restarts: { recent: 0 },
    });
  });

  it("has no figures while the manager doesn't answer", async () => {
    const home = await versions();
    home.manager.appUsage = async () => {
      throw new Error("The manager did not answer");
    };
    const core = await home.coreWith(version("1.0.0"));
    await isRunning(core, id);

    expect(await read(core)).toEqual({
      memoryBytes: null,
      processor: null,
      dataBytes: null,
      restarts: { recent: 0 },
    });
  });

  it("counts its restarts and says what stopped it last", async () => {
    const home = await versions();
    const core = await home.coreWith(version("1.0.0"));
    await isRunning(core, id);

    await home.stopContainer();
    await vi.waitFor(() => expect(stateOf(core, id).run?.failures).toBe(1));
    await isRunning(core, id);

    expect((await read(core))?.restarts).toEqual({
      recent: 1,
      last: { at: expect.any(String), failure: "crashed" },
    });
  });

  it("asks who's asking", async () => {
    const home = await versions();
    const core = await home.coreWith(version("1.0.0"));

    const answer = await get(core, `/api/apps/${id}/running`);

    expect(answer.statusCode).toBe(401);
  });
});

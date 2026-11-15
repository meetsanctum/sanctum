import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { testCore, type TestCore } from "./support.js";

describe("the test cores' cleanup", () => {
  const cores: TestCore[] = [];

  it.fails("reports a core's event ordering error during cleanup", async () => {
    const first = await testCore();
    cores.push(first);
    cores.push(await testCore({ dataDir: first.dataDir }));
    cores.push(await testCore());
    first.logs.push("events: cleanup check");
  });

  // These checks run outside the test whose cleanup is expected to fail.
  afterAll(() => {
    expect(cores).toHaveLength(3);
    expect(cores.map((core) => core.db.$client.open)).toEqual([
      false,
      false,
      false,
    ]);
    expect(cores.map((core) => existsSync(core.dataDir))).toEqual([
      false,
      false,
      false,
    ]);
  });
});

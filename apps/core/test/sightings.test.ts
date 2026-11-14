import { afterEach, describe, expect, it, vi } from "vitest";

import { createSightings } from "../src/discovery/sightings.js";
import type { DiscoveryAnswer } from "../src/manager.js";

const answer: DiscoveryAnswer = {
  after: "run:1",
  full: true,
  found: [],
  lost: [],
};

describe("following the manager's sightings", () => {
  afterEach(() => vi.useRealTimers());

  it("stops the manager's browsers when the last service is no longer needed", async () => {
    vi.useFakeTimers();
    let services = ["_example._tcp"];
    const discovery = vi.fn(async () => {
      services = [];
      return answer;
    });
    const sightings = createSightings({
      manager: { capabilities: () => ({ discovery: true }), discovery },
      services: () => services,
      onChange: vi.fn(),
      log: vi.fn(),
    });
    sightings.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(discovery.mock.calls).toEqual([
      [null, ["_example._tcp"]],
      [null, []],
    ]);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(discovery).toHaveBeenCalledTimes(2);
    sightings.close();
  });

  it("ignores a manager answer that arrives after closing", async () => {
    let resolve!: (answer: DiscoveryAnswer) => void;
    const onChange = vi.fn();
    const sightings = createSightings({
      manager: {
        capabilities: () => ({ discovery: true }),
        discovery: () =>
          new Promise((done) => {
            resolve = done;
          }),
      },
      services: () => ["_example._tcp"],
      onChange,
      log: vi.fn(),
    });
    sightings.start();
    sightings.close();
    resolve({
      ...answer,
      found: [
        {
          service: "_example._tcp",
          name: "kitchen",
          host: "kitchen.local",
          addresses: ["192.168.1.40"],
          port: 8080,
          txt: {},
        },
      ],
    });
    await Promise.resolve();
    expect(onChange).not.toHaveBeenCalled();
    expect(sightings.list()).toEqual([]);
  });
});

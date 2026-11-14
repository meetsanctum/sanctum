import {
  defineApp,
  type DriverDiscovery,
  type Sighting,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { fakeManager, testCore } from "./support.js";

// What a driver hears of the home's network: the manager finds what the
// core asks for, and the core hands each driver the sightings of the
// services it may look for, every one as it starts, then each change.

const kitchen: Sighting = {
  service: "_example._tcp",
  name: "kitchen-sensor",
  host: "kitchen-sensor.local",
  addresses: ["192.168.1.40"],
  port: 8080,
  txt: { mac: "aabbccddeeff" },
};

function finder(
  heard: DriverDiscovery[],
  needed = true,
  { id = "test.finder", service = "_example._tcp" } = {},
) {
  return defineApp({
    id,
    name: "Finder",
    version: "0.1.0",
    core: "^1.0.0",
    permissions: [
      { id: "devices.register", reason: "For the test.", needed: true },
      {
        id: `discover:mdns:${service}`,
        reason: "For the test.",
        needed,
      },
    ],
    actions: [],
    events: [],
    driver: {
      async command() {},
      async discovered(_ctx, discovery) {
        heard.push(discovery);
      },
    },
  });
}

async function finding(
  options: { needed?: boolean; discovers?: boolean } = {},
) {
  const heard: DriverDiscovery[] = [];
  const fake = fakeManager();
  if (options.discovers === false) {
    fake.manager.capabilities = () => ({
      appContainers: true,
      memoryLimits: true,
      discovery: false,
    });
  }
  const core = await testCore({
    manager: fake.manager,
    allowed: false,
    apps: [{ app: finder(heard, options.needed), origin: "official" }],
  });
  return { core, heard, network: fake.network };
}

describe("finding devices", () => {
  it("hands a driver what it looks for, all as it starts, then each change", async () => {
    const { heard, network } = await finding();
    await expect.poll(() => heard).toEqual([{ found: [], lost: [] }]);
    await expect.poll(() => network.asked.at(-1)).toEqual(["_example._tcp"]);

    network.put(kitchen);
    await expect
      .poll(() => heard.at(-1))
      .toEqual({ found: [kitchen], lost: [] });

    const moved = { ...kitchen, addresses: ["192.168.1.41"] };
    network.put(moved);
    await expect.poll(() => heard.at(-1)).toEqual({ found: [moved], lost: [] });

    network.take(kitchen);
    await expect
      .poll(() => heard.at(-1))
      .toEqual({
        found: [],
        lost: [{ service: "_example._tcp", name: "kitchen-sensor" }],
      });
  });

  it("hands a driver only the services it may look for", async () => {
    const { heard, network } = await finding();
    await expect.poll(() => network.asked.length).toBeGreaterThan(0);

    network.put({ ...kitchen, service: "_other._tcp" });
    network.put(kitchen);
    await expect
      .poll(() => heard.at(-1))
      .toEqual({ found: [kitchen], lost: [] });
    expect(heard.flatMap((each) => each.found)).toEqual([kitchen]);
  });

  it("hands each of two drivers only what it looks for", async () => {
    const heard: DriverDiscovery[] = [];
    const others: DriverDiscovery[] = [];
    const fake = fakeManager();
    await testCore({
      manager: fake.manager,
      allowed: false,
      apps: [
        { app: finder(heard), origin: "official" },
        {
          app: finder(others, true, {
            id: "test.other",
            service: "_other._tcp",
          }),
          origin: "official",
        },
      ],
    });
    const other = { ...kitchen, service: "_other._tcp", name: "hall-plug" };
    fake.network.put(kitchen);
    fake.network.put(other);

    await expect
      .poll(() => fake.network.asked.at(-1))
      .toEqual(["_example._tcp", "_other._tcp"]);
    await expect
      .poll(() => heard.flatMap((each) => each.found))
      .toEqual([kitchen]);
    await expect
      .poll(() => others.flatMap((each) => each.found))
      .toEqual([other]);
  });

  it("looks for nothing a driver hasn't been allowed to", async () => {
    const { heard, network } = await finding({ needed: false });
    network.put(kitchen);

    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(network.asked).toEqual([]);
    expect(heard).toEqual([]);
  });

  it("finds nothing under a manager that can't look", async () => {
    const { heard, network } = await finding({ discovers: false });
    network.put(kitchen);

    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(network.asked).toEqual([]);
    expect(heard).toEqual([{ found: [], lost: [] }]);
  });
});

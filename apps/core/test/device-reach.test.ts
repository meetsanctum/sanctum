import {
  defineApp,
  type AppInfo,
  type DriverDiscovery,
  type Sighting,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { ManagerUnavailable } from "../src/manager.js";
import { claimed, fakeManager, testCore } from "./support.js";

// A driver that reaches the devices it finds: its network's rules let it
// open connections only to their addresses, on its port. The manager loads
// the first policy before its container starts and each change after; the
// driver hears of an address only once the manager confirms a policy that
// holds it, and switching off what narrows its reach waits for that.

const app = "test.reacher";
const kitchen: Sighting = {
  service: "_example._tcp",
  name: "kitchen-sensor",
  host: "kitchen-sensor.local",
  addresses: ["192.168.1.40"],
  port: 6053,
  txt: {},
};

function reacher(
  heard: DriverDiscovery[],
  lanNeeded: boolean,
  serviceNeeded = false,
) {
  return defineApp({
    id: app,
    name: "Reacher",
    version: "0.1.0",
    core: "^1.0.0",
    permissions: [
      { id: "devices.register", reason: "For the test.", needed: true },
      {
        id: "discover:mdns:_example._tcp",
        reason: "For the test.",
        needed: true,
      },
      { id: "lan:tcp:6053", reason: "For the test.", needed: lanNeeded },
      ...(serviceNeeded
        ? [{ id: "services:mqtt", reason: "For the test.", needed: true }]
        : []),
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

async function reaching(
  options: {
    can?: boolean;
    lanNeeded?: boolean;
    allowed?: boolean;
    serviceNeeded?: boolean;
  } = {},
) {
  const heard: DriverDiscovery[] = [];
  const fake = fakeManager();
  fake.lan.can = options.can ?? true;
  const core = await testCore({
    manager: fake.manager,
    allowed: options.allowed ?? true,
    apps: [
      {
        app: reacher(heard, options.lanNeeded ?? true, options.serviceNeeded),
        origin: "official",
      },
    ],
  });
  const maya = await claimed(core);
  const grant = (permission: string, granted: boolean) =>
    core.apps.setPermission({
      principal: core.auth.clients.authenticate(maya.token)!,
      appId: app,
      permission,
      granted,
    });
  const info = () =>
    (core.apps.list() as AppInfo[]).find((each) => each.id === app)!;
  return { core, heard, grant, info, ...fake };
}

// Holds the manager's answers back until `release`.
function holdAnswers(lan: { answering: Promise<void> }) {
  let release!: () => void;
  lan.answering = new Promise<void>((resolve) => (release = resolve));
  return () => {
    lan.answering = Promise.resolve();
    release();
  };
}

describe("reaching devices", () => {
  it("loads its first policy with its container, before it hears of anything", async () => {
    const { heard, lan } = await reaching();

    await expect.poll(() => heard).toEqual([{ found: [], lost: [] }]);
    expect(lan.loaded).toEqual([
      {
        app,
        policy: expect.objectContaining({ addresses: [], ports: [6053] }),
        holder: "holder-1",
      },
    ]);
  });

  it("hears of an address only once the manager confirms a policy that holds it", async () => {
    const { heard, network, lan } = await reaching();
    await expect.poll(() => heard.length).toBe(1);
    const release = holdAnswers(lan);

    network.put(kitchen);
    await expect
      .poll(() => lan.asked.at(-1))
      .toMatchObject({ addresses: ["192.168.1.40"], ports: [6053] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(heard).toHaveLength(1);

    release();
    await expect
      .poll(() => heard.at(-1))
      .toEqual({ found: [kitchen], lost: [] });
    expect(lan.of(app)).toMatchObject({ addresses: ["192.168.1.40"] });
  });

  it("cuts what a permission switched off reached before it says it's off", async () => {
    const { heard, network, lan, grant, info } = await reaching();
    network.put(kitchen);
    await expect.poll(() => heard.at(-1)?.found).toEqual([kitchen]);
    const release = holdAnswers(lan);

    let isOff = false;
    const switching = grant("discover:mdns:_example._tcp", false).then(() => {
      isOff = true;
    });
    // Its policy without it is on its way, and the switch waits for it.
    await expect
      .poll(() => lan.asked.at(-1))
      .toMatchObject({ addresses: [], ports: [] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isOff).toBe(false);
    expect(info().permissions).toContain("discover:mdns:_example._tcp");

    release();
    await switching;
    expect(lan.of(app)).toMatchObject({ addresses: [], ports: [] });
    expect(info().state).toBe("paused");
  });

  it("keeps a permission on when the manager can't confirm what it narrows", async () => {
    const { heard, network, manager, grant, info } = await reaching();
    network.put(kitchen);
    await expect.poll(() => heard.at(-1)?.found).toEqual([kitchen]);
    const applying = manager.applyLanPolicy;
    manager.applyLanPolicy = async () => {
      throw new ManagerUnavailable("The manager did not answer");
    };

    await expect(grant("lan:tcp:6053", false)).rejects.toThrow();
    expect(info().permissions).toContain("lan:tcp:6053");
    manager.applyLanPolicy = applying;
  });

  it("hears nothing more once the manager no longer has its holder", async () => {
    const { heard, network, lan } = await reaching();
    network.put(kitchen);
    await expect.poll(() => heard.at(-1)?.found).toEqual([kitchen]);

    // Its container's network went, as when it was made again.
    lan.holders.set(app, "holder-gone");
    network.put({ ...kitchen, addresses: ["192.168.1.41"] });

    await expect
      .poll(() => heard.at(-1))
      .toEqual({
        found: [],
        lost: [{ service: "_example._tcp", name: "kitchen-sensor" }],
      });
  });

  it("restores its network when a service's revocation fails after its policy narrowed", async () => {
    const { heard, network, manager, lan, grant, info } = await reaching({
      serviceNeeded: true,
    });
    network.put(kitchen);
    await expect.poll(() => heard.at(-1)?.found).toEqual([kitchen]);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    manager.revokeService = async () => {
      await waiting;
      throw new ManagerUnavailable("No answer");
    };

    const switching = expect(grant("services:mqtt", false)).rejects.toThrow();
    try {
      await expect
        .poll(() => lan.of(app))
        .toMatchObject({
          addresses: [],
          ports: [],
        });
    } finally {
      release();
    }
    await switching;
    expect(info().permissions).toContain("services:mqtt");
    await expect
      .poll(() => lan.of(app))
      .toMatchObject({
        addresses: kitchen.addresses,
        ports: [6053],
      });
  });

  it("gets a container with a network of its own once it's allowed to reach devices", async () => {
    const { lan, grant } = await reaching({ lanNeeded: false, allowed: false });
    await grant("discover:mdns:_example._tcp", true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(lan.loaded).toEqual([]);

    await grant("lan:tcp:6053", true);

    await expect
      .poll(() => lan.loaded)
      .toEqual([
        {
          app,
          policy: expect.objectContaining({ ports: [6053] }),
          holder: "holder-1",
        },
      ]);
  });

  it("never runs on rules the manager didn't say it loaded", async () => {
    const heard: DriverDiscovery[] = [];
    const fake = fakeManager();
    fake.lan.can = true;
    // It answers for a policy other than the one it was sent.
    fake.manager.startAppContainer = async (_app, spec) => ({
      kept: false,
      ...(spec.lan
        ? {
            lan: {
              core: spec.lan.core,
              count: spec.lan.count + 1,
              manager: "test",
              holder: "holder-1",
            },
          }
        : {}),
    });
    const core = await testCore({
      manager: fake.manager,
      apps: [{ app: reacher(heard, true), origin: "official" }],
    });

    await expect
      .poll(() =>
        core.logs.some((line) =>
          line.includes("its network's rules weren't loaded"),
        ),
      )
      .toBe(true);
    expect(heard).toEqual([]);
  });

  it("keeps a paused app from starting while its new network waits for confirmation", async () => {
    const { heard, manager, grant, info } = await reaching({
      lanNeeded: false,
      allowed: false,
    });
    await expect.poll(() => heard.length).toBe(1);
    await grant("discover:mdns:_example._tcp", false);
    await expect.poll(() => info().state).toBe("paused");
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    let wasAsked = false;
    const start = manager.startAppContainer;
    manager.startAppContainer = async (appId, spec) => {
      wasAsked = true;
      await waiting;
      return start(appId, spec);
    };

    try {
      await grant("lan:tcp:6053", true);
      await expect.poll(() => wasAsked).toBe(true);
      await grant("discover:mdns:_example._tcp", true);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(info().state).toBe("starting");
    } finally {
      release();
    }
    await expect.poll(() => info().state).toBe("running");
  });

  it("waits, saying why, under a manager that can't give it a network of its own", async () => {
    const { heard, lan, info } = await reaching({ can: false });

    await expect
      .poll(() => info().run?.waitingFor)
      .toBe("Waiting for an update that lets it reach your devices");
    expect(info().state).toBe("waiting");
    expect(lan.loaded).toEqual([]);
    expect(heard).toEqual([]);
  });
});

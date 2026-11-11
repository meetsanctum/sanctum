import { afterEach, describe, expect, it, vi } from "vitest";

import type { Operation } from "../src/operations.js";
import { mosquittoImage } from "../src/services/mosquitto.js";
import { zigbee2mqttImage } from "../src/services/zigbee2mqtt.js";
import { zbt2 } from "./host-dev.js";
import {
  bridge,
  app,
  managedVolume,
  oldImage,
  setup,
  volume,
} from "./service-image-support.js";

// A service's change of image takes its turn with the host's other operations
// (apps/manager/src/operations.ts).

vi.mock("../src/durable.js", async (original) => ({
  ...(await original<typeof import("../src/durable.js")>()),
  syncFileSystem: async () => {},
}));

describe("a service's new image, taking its turn", () => {
  const update: Operation = { kind: "core-update", version: "dev-2" };
  const moving = {
    kind: "service-image",
    service: "zigbee2mqtt",
    to: zigbee2mqttImage,
  };
  const minutes = (count: number) => count * 60_000;

  it("waits on its version, untouched, while another operation holds the slot", async () => {
    let holder: Operation | null = update;
    const { copies, docker, services, store } = await setup({
      holder: () => holder,
    });

    await services.reconcile();

    expect(docker.imageOf(bridge)?.tags.has(oldImage)).toBe(true);
    expect(docker.container(bridge)?.running).toBe(true);
    expect(docker.volumeData.get(volume)).toBe("the network key");
    expect(await copies()).toEqual([]);
    expect(store.current().imageChanges?.zigbee2mqtt).toBeUndefined();

    holder = null;
    await services.reconcile();

    expect(docker.imageOf(bridge)?.tags.has(zigbee2mqttImage)).toBe(true);
    expect(store.current().imageChanges?.zigbee2mqtt?.status).toBe("checking");
  });

  it("holds the slot through its time under observation, until it commits", async () => {
    const { operations, services, settle } = await setup();
    expect(await operations.current()).toBeNull();

    await services.reconcile();
    expect(await operations.current()).toEqual(moving);

    settle();
    await services.reconcile();

    expect(await operations.current()).toBeNull();
  });

  it("is found holding it by a manager that starts meanwhile", async () => {
    const { services, start } = await setup();
    await services.reconcile();

    const { operations: restarted } = await start();

    expect(await restarted.current()).toEqual(moving);
  });

  it("holds it while its version is going back, until it's back", async () => {
    const { crashLoop, operations, services, store } = await setup();
    await services.reconcile();
    await store.update((draft) => {
      draft.imageChanges!.zigbee2mqtt!.status = "restoring";
    });
    expect(await operations.current()).toEqual(moving);

    crashLoop();
    await services.reconcile();

    expect(store.current().imageChanges?.zigbee2mqtt?.status).toBe("kept-back");
    expect(await operations.current()).toBeNull();
  });

  describe("past its time limit", () => {
    afterEach(() => vi.useRealTimers());

    it("gives the slot up while it hasn't settled, and is still judged", async () => {
      const { crashLoop, dev, docker, operations, services, store } =
        await setup();
      await services.reconcile();
      // Its coordinator is unplugged, so it neither settles nor fails.
      await dev.unplug(zbt2, "ttyACM0");
      await services.reconcile();
      expect(docker.container(bridge)?.running).toBe(false);

      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + minutes(9) });
      expect(await operations.current()).toEqual(moving);
      vi.setSystemTime(Date.now() + minutes(2));
      expect(await operations.current()).toBeNull();

      await dev.plug(zbt2, "ttyACM0");
      await services.reconcile();
      crashLoop();
      await services.reconcile();

      expect(store.current().imageChanges?.zigbee2mqtt?.status).toBe(
        "kept-back",
      );
    });

    it("doesn't hold it for a change that an older manager began", async () => {
      const { operations, services, store } = await setup();
      await services.reconcile();
      await store.update((draft) => {
        delete draft.imageChanges!.zigbee2mqtt!.startedAt;
      });

      expect(await operations.current()).toBeNull();
    });

    it("waits to put a failed version back while another operation holds the slot", async () => {
      let holder: Operation | null = null;
      const { crashLoop, docker, operations, services, store } = await setup({
        holder: () => holder,
      });
      await services.reconcile();
      vi.useFakeTimers({ toFake: ["Date"], now: Date.now() + minutes(11) });
      crashLoop();
      holder = update;
      docker.events = [];

      await services.reconcile();

      expect(docker.events).toEqual([]);
      expect(docker.volumeData.get(volume)).toBe("migrated");
      expect(store.current().imageChanges?.zigbee2mqtt?.status).toBe(
        "checking",
      );
      expect(await operations.current()).toEqual(update);

      holder = null;
      await services.reconcile();

      expect(docker.volumeData.get(volume)).toBe("the network key");
      expect(store.current().imageChanges?.zigbee2mqtt?.status).toBe(
        "kept-back",
      );
      expect(await operations.current()).toBeNull();
    });
  });

  it("finishes restoring an unwanted service so it cannot hold the slot forever", async () => {
    const { crashLoop, docker, services, start, store } = await setup();
    await services.reconcile();
    crashLoop();
    docker.putArchiveError = new Error("The manager went down");
    await services.reconcile();
    expect(store.current().imageChanges?.zigbee2mqtt?.status).toBe("restoring");
    await store.update((draft) => {
      delete draft.apps.zigbee2mqtt;
    });

    const restarted = await start();
    await restarted.services.reconcile();

    expect(restarted.store.current().imageChanges?.zigbee2mqtt?.status).toBe(
      "kept-back",
    );
    expect(docker.volumeData.get(volume)).toBe("the network key");
    expect(docker.container(bridge)).toBeUndefined();
    expect(await restarted.operations.current()).toBeNull();

    await restarted.services.need("zigbee2mqtt", app);
    await restarted.services.reconcile();
    expect(docker.imageOf(bridge)?.tags.has(oldImage)).toBe(true);
    expect(docker.volumeData.get(volume)).toBe("the network key");
  });

  it("finishes restoring with its coordinator unplugged, without starting the service", async () => {
    const { crashLoop, dev, docker, services, start, store } = await setup();
    await services.reconcile();
    crashLoop();
    docker.putArchiveError = new Error("The manager went down");
    await services.reconcile();
    expect(store.current().imageChanges?.zigbee2mqtt?.status).toBe("restoring");
    await dev.unplug(zbt2, "ttyACM0");

    const restarted = await start();
    await restarted.services.reconcile();

    expect(restarted.store.current().imageChanges?.zigbee2mqtt?.status).toBe(
      "kept-back",
    );
    expect(docker.volumeData.get(volume)).toBe("the network key");
    expect(docker.container(bridge)).toBeUndefined();
    expect(restarted.services.status("zigbee2mqtt").state).toBe("waiting");
    expect(await restarted.operations.current()).toBeNull();
  });

  it("lets two services move one at a time", async () => {
    const { docker, services, store } = await setup();
    const broker = "sanctum-mosquitto";
    const brokerVolume = "sanctum-mosquitto-data";
    const oldBroker = "eclipse-mosquitto:2.0.20";
    docker.load(oldBroker, { title: "mosquitto", version: "2.0.20" });
    docker.volumes.set(brokerVolume, managedVolume);
    docker.run({
      name: broker,
      Image: oldBroker,
      Labels: {
        "sanctum.managed": "true",
        "sanctum.role": "mosquitto",
        "sanctum.definition": "from-an-older-manager",
      },
      HostConfig: { Binds: [`${brokerVolume}:/mosquitto/data`] },
    });

    await services.reconcile();

    // The broker first, as the services start, and the bridge waits untouched.
    expect(Object.keys(store.current().imageChanges ?? {})).toEqual([
      "mosquitto",
    ]);
    expect(docker.imageOf(broker)?.tags.has(mosquittoImage)).toBe(true);
    expect(docker.imageOf(bridge)?.tags.has(oldImage)).toBe(true);
    expect(docker.volumeData.get(volume)).toBe("the network key");

    docker.container(broker)!.startedAt = new Date(Date.now() - minutes(10));
    await services.reconcile();

    expect(Object.keys(store.current().imageChanges ?? {})).toEqual([
      "zigbee2mqtt",
    ]);
    expect(docker.imageOf(bridge)?.tags.has(zigbee2mqttImage)).toBe(true);
  });

  it("keeps one kept back on the volumes its data went back to, while it waits", async () => {
    const elsewhere = "sanctum-zigbee2mqtt-from-before";
    const { docker, services, store } = await setup({ holder: () => update });
    docker.volumes.set(elsewhere, managedVolume);
    const kept = {
      from: oldImage,
      to: "ghcr.io/koenkk/zigbee2mqtt:2.14.0",
      backup: "/data/backups/zigbee2mqtt-20260101T000000-2.13.0",
      volumes: [{ name: elsewhere, target: "/app/data" }],
      status: "kept-back" as const,
    };
    await store.update((draft) => {
      draft.imageChanges = { zigbee2mqtt: kept };
    });

    await services.reconcile();

    expect(store.current().imageChanges?.zigbee2mqtt).toEqual(kept);
    expect(docker.imageOf(bridge)?.tags.has(oldImage)).toBe(true);
    expect(docker.container(bridge)?.options.HostConfig?.Binds).toEqual([
      `${elsewhere}:/app/data`,
    ]);
  });

  it("says it's waiting once, rather than on every pass", async () => {
    const log = vi.fn();
    const { docker, services } = await setup({ holder: () => update, log });
    expect(docker.container(bridge)).toBeDefined();

    await services.reconcile();
    await services.reconcile();

    const waiting = log.mock.calls.filter(([line]) =>
      String(line).includes("for now"),
    );
    expect(waiting).toHaveLength(1);
    expect(waiting[0]![0]).toContain("An update is already running");
  });
});

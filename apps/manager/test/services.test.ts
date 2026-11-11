import { pbkdf2Sync } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { sanctumNetworkName } from "../src/core-container.js";
import { createOperations } from "../src/operations.js";
import { mosquittoImage } from "../src/services/mosquitto.js";
import {
  createServices,
  ServiceRequestError,
  UnknownServiceError,
} from "../src/services/services.js";
import { createServicesStateStore } from "../src/services/state.js";
import { zigbee2mqttImage } from "../src/services/zigbee2mqtt.js";
import { FakeDocker } from "./fake-docker.js";
import { conbee, hostDev, zbt2 } from "./host-dev.js";

const app = "sanctum.zigbee";

async function setup() {
  const docker = new FakeDocker();
  docker.publish(mosquittoImage, { title: "mosquitto", version: "2.1.2" });
  docker.publish(zigbee2mqttImage, { title: "zigbee2mqtt", version: "2.14.2" });
  const dataDir = await mkdtemp(join(tmpdir(), "sanctum-manager-"));
  const dev = await hostDev();
  const log = vi.fn();
  const onChange = vi.fn();
  const store = await createServicesStateStore(dataDir);
  // A manager process: a restart or an update makes a new one over the
  // same data and containers.
  const start = async (stateStore?: typeof store) => {
    const services = createServices({
      operations: createOperations(),
      docker,
      store: stateStore ?? (await createServicesStateStore(dataDir)),
      dataDir,
      hostDevDir: dev.root,
      log,
      onChange,
    });
    await services.start();
    return services;
  };
  return {
    docker,
    dataDir,
    dev,
    log,
    onChange,
    store,
    services: await start(store),
    start,
  };
}

function env(docker: FakeDocker, name: string) {
  return Object.fromEntries(
    (docker.container(name)?.options.Env ?? []).map((entry) => {
      const at = entry.indexOf("=");
      return [entry.slice(0, at), entry.slice(at + 1)];
    }),
  );
}

// The files the broker's container writes before it starts.
function brokerFiles(docker: FakeDocker) {
  const variables = env(docker, "sanctum-mosquitto");
  const decode = (name: string) =>
    Buffer.from(variables[name] ?? "", "base64").toString("utf8");
  return {
    passwords: decode("SANCTUM_MOSQUITTO_PASSWORDS"),
    acl: decode("SANCTUM_MOSQUITTO_ACL"),
    config: decode("SANCTUM_MOSQUITTO_CONFIG"),
  };
}

function checkPassword(passwords: string, username: string, password: string) {
  const line = passwords
    .split("\n")
    .find((each) => each.startsWith(`${username}:`));
  const [, , iterations, salt, hash] = line!.split("$");
  return (
    pbkdf2Sync(
      password,
      Buffer.from(salt!, "base64"),
      Number(iterations),
      64,
      "sha512",
    ).toString("base64") === hash
  );
}

describe("services", () => {
  it("runs nothing until an app needs a service", async () => {
    const { docker, services } = await setup();
    await services.reconcile();

    expect(docker.containers.size).toBe(0);
    expect(services.list()).toEqual([
      { name: "mosquitto", apps: [], state: "off" },
      { name: "zigbee2mqtt", apps: [], state: "off" },
    ]);
  });

  it("starts the broker, then Zigbee2MQTT, for an app that needs it", async () => {
    const { docker, dev, services } = await setup();
    await dev.plug(zbt2, "ttyACM0");

    const { service, connection } = await services.need("zigbee2mqtt", app);
    expect(service).toEqual({
      name: "zigbee2mqtt",
      apps: [app],
      state: "starting",
    });
    expect(connection).toEqual({
      mqtt: {
        url: "mqtt://sanctum-mosquitto:1883",
        username: app,
        password: expect.any(String),
        topics: ["zigbee2mqtt/#"],
      },
      baseTopic: "zigbee2mqtt",
    });

    await services.reconcile();

    expect(docker.events).toEqual([
      `pull ${mosquittoImage}`,
      "create sanctum-mosquitto 2.1.2",
      "start sanctum-mosquitto",
      `pull ${zigbee2mqttImage}`,
      "create sanctum-zigbee2mqtt 2.14.2",
      "start sanctum-zigbee2mqtt",
    ]);
    expect(services.list()).toEqual([
      expect.objectContaining({
        name: "mosquitto",
        apps: [],
        state: "running",
      }),
      expect.objectContaining({
        name: "zigbee2mqtt",
        apps: [app],
        state: "running",
        image: zigbee2mqttImage,
        restarts: 0,
      }),
    ]);
    for (const name of ["sanctum-mosquitto", "sanctum-zigbee2mqtt"]) {
      const container = docker.container(name);
      expect(container?.networks[sanctumNetworkName]).toBeDefined();
      expect(container?.options.HostConfig).toMatchObject({
        RestartPolicy: { Name: "unless-stopped" },
      });
      // Nothing outside the host's Docker network reaches a service.
      expect(container?.options.HostConfig?.PortBindings).toBeUndefined();
    }
    expect(docker.volumes.get("sanctum-mosquitto-data")).toEqual({
      "sanctum.managed": "true",
    });
    expect(docker.volumes.has("sanctum-zigbee2mqtt-data")).toBe(true);
  });

  it("gives every client its own broker account, limited to its topics", async () => {
    const { docker, dev, services } = await setup();
    await dev.plug(zbt2, "ttyACM0");
    const { connection } = await services.need("zigbee2mqtt", app);
    await services.reconcile();

    const { passwords, acl, config } = brokerFiles(docker);
    const bridge = env(docker, "sanctum-zigbee2mqtt");
    expect(bridge).toMatchObject({
      ZIGBEE2MQTT_CONFIG_MQTT_SERVER: "mqtt://sanctum-mosquitto:1883",
      ZIGBEE2MQTT_CONFIG_MQTT_USER: "zigbee2mqtt",
    });
    expect(
      checkPassword(
        passwords,
        "zigbee2mqtt",
        bridge.ZIGBEE2MQTT_CONFIG_MQTT_PASSWORD!,
      ),
    ).toBe(true);
    expect(checkPassword(passwords, app, connection.mqtt!.password)).toBe(true);
    expect(connection.mqtt!.password).not.toBe(
      bridge.ZIGBEE2MQTT_CONFIG_MQTT_PASSWORD,
    );
    // Only hashes reach the broker.
    expect(passwords).not.toContain(connection.mqtt!.password);
    expect(acl).toBe(
      [
        "user sanctum.zigbee",
        "topic readwrite zigbee2mqtt/#",
        "",
        "user zigbee2mqtt",
        "topic readwrite zigbee2mqtt/#",
        "",
      ].join("\n"),
    );
    expect(config).toContain("allow_anonymous false");
  });

  it("hands the coordinator to Zigbee2MQTT with its serial settings", async () => {
    const { dataDir, docker, dev, services } = await setup();
    await dev.plug(zbt2, "ttyACM0");
    await services.need("zigbee2mqtt", app);
    await services.reconcile();

    const container = docker.container("sanctum-zigbee2mqtt");
    expect(container?.options.HostConfig?.Devices).toEqual([
      {
        PathOnHost: zbt2,
        PathInContainer: "/dev/zigbee",
        CgroupPermissions: "rwm",
      },
    ]);
    expect(container?.options.HostConfig?.Binds).toEqual([
      "sanctum-zigbee2mqtt-data:/app/data",
    ]);
    expect(env(docker, "sanctum-zigbee2mqtt")).toMatchObject({
      Z2M_ONBOARD_NO_SERVER: "1",
      ZIGBEE2MQTT_CONFIG_SERIAL_PORT: "/dev/zigbee",
      ZIGBEE2MQTT_CONFIG_SERIAL_ADAPTER: "ember",
      ZIGBEE2MQTT_CONFIG_SERIAL_BAUDRATE: "460800",
      ZIGBEE2MQTT_CONFIG_SERIAL_RTSCTS: "true",
      ZIGBEE2MQTT_CONFIG_ADVANCED_LAST_SEEN: "ISO_8601",
      ZIGBEE2MQTT_CONFIG_AVAILABILITY_ENABLED: "true",
      ZIGBEE2MQTT_CONFIG_FRONTEND_ENABLED: "false",
      ZIGBEE2MQTT_CONFIG_ADVANCED_ADAPTER_DELAY: "0",
    });
    // The pick is kept, so a second coordinator changes nothing later.
    const saved = JSON.parse(
      await readFile(join(dataDir, "services.json"), "utf8"),
    );
    expect(saved.zigbeeCoordinator).toEqual({
      path: zbt2,
      adapter: "ember",
      profileId: "nabu-casa-zbt-2",
    });
    await dev.plug(conbee, "ttyACM1");
    docker.events = [];
    await services.reconcile();
    expect(docker.events).toEqual([]);
  });

  it("leaves running services alone, and replaces only what changed", async () => {
    const { docker, dev, services } = await setup();
    await dev.plug(zbt2, "ttyACM0");
    await services.need("zigbee2mqtt", app);
    await services.reconcile();
    const bridge = docker.container("sanctum-zigbee2mqtt")?.id;
    docker.events = [];

    await services.reconcile();
    expect(docker.events).toEqual([]);

    // A second app gets an account of its own: the broker is replaced with
    // the new accounts, the bridge keeps running.
    await services.need("zigbee2mqtt", "sanctum.other");
    await services.reconcile();
    expect(docker.events).toEqual([
      "stop sanctum-mosquitto",
      "remove sanctum-mosquitto",
      "create sanctum-mosquitto 2.1.2",
      "start sanctum-mosquitto",
    ]);
    expect(docker.container("sanctum-zigbee2mqtt")?.id).toBe(bridge);
    expect(brokerFiles(docker).passwords).toContain("sanctum.other:");
    // The image is still in use, so it stays.
    expect(docker.imageOf("sanctum-mosquitto")).toBeDefined();
  });

  it("keeps services as they are across a manager restart", async () => {
    const { docker, dev, services, start } = await setup();
    await dev.plug(zbt2, "ttyACM0");
    const first = await services.need("zigbee2mqtt", app);
    await services.reconcile();
    docker.events = [];

    const restarted = await start();
    await restarted.reconcile();

    expect(docker.events).toEqual([]);
    expect(restarted.status("zigbee2mqtt")).toMatchObject({ state: "running" });
    const again = await restarted.need("zigbee2mqtt", app);
    expect(again.connection).toEqual(first.connection);
  });

  it("starts the containers a reboot or a person stopped", async () => {
    const { docker, dev, services } = await setup();
    await dev.plug(zbt2, "ttyACM0");
    await services.need("zigbee2mqtt", app);
    await services.reconcile();
    for (const container of docker.containers.values()) {
      container.running = false;
    }
    docker.events = [];

    await services.reconcile();

    expect(docker.events).toEqual([
      "start sanctum-mosquitto",
      "start sanctum-zigbee2mqtt",
    ]);
  });

  it("waits for a coordinator, then uses the one plugged in", async () => {
    const { docker, dev, services } = await setup();
    await services.need("zigbee2mqtt", app);
    await services.reconcile();

    expect(services.status("mosquitto")).toMatchObject({ state: "running" });
    expect(services.status("zigbee2mqtt")).toMatchObject({
      state: "waiting",
      problem: "No Zigbee coordinator is plugged in",
    });
    expect(docker.container("sanctum-zigbee2mqtt")).toBeUndefined();

    await dev.plug(zbt2, "ttyACM0");
    await services.reconcile();
    expect(services.status("zigbee2mqtt")).toMatchObject({ state: "running" });
  });

  it("stops Zigbee2MQTT while its coordinator is unplugged", async () => {
    const { docker, dev, services } = await setup();
    await dev.plug(zbt2, "ttyACM0");
    await services.need("zigbee2mqtt", app);
    await services.reconcile();
    const bridge = docker.container("sanctum-zigbee2mqtt");

    await dev.unplug(zbt2, "ttyACM0");
    await services.reconcile();
    expect(bridge?.running).toBe(false);
    expect(services.status("zigbee2mqtt")).toMatchObject({
      state: "waiting",
      problem: `The Zigbee coordinator ${zbt2} is not plugged in`,
    });

    // It may come back as another tty; the by-id path stays the same.
    await dev.plug(zbt2, "ttyACM1");
    await services.reconcile();
    expect(docker.container("sanctum-zigbee2mqtt")).toBe(bridge);
    expect(bridge?.running).toBe(true);
  });

  it("asks which coordinator when several are plugged in, and uses the chosen one", async () => {
    const { docker, dev, services } = await setup();
    await dev.plug(zbt2, "ttyACM0");
    await dev.plug(conbee, "ttyACM1");
    await services.need("zigbee2mqtt", app);
    await services.reconcile();
    expect(services.status("zigbee2mqtt")).toMatchObject({
      state: "waiting",
      problem: expect.stringMatching(/Several .* choose one/),
    });

    await expect(
      services.chooseZigbeeCoordinator("/dev/ttyUSB9"),
    ).rejects.toThrow(ServiceRequestError);
    const { chosen } = await services.chooseZigbeeCoordinator(conbee);
    expect(chosen).toEqual({ path: conbee, adapter: "deconz" });
    await services.reconcile();

    expect(env(docker, "sanctum-zigbee2mqtt")).toMatchObject({
      ZIGBEE2MQTT_CONFIG_SERIAL_ADAPTER: "deconz",
      ZIGBEE2MQTT_CONFIG_SERIAL_BAUDRATE: "38400",
      ZIGBEE2MQTT_CONFIG_SERIAL_RTSCTS: "false",
      ZIGBEE2MQTT_CONFIG_ADVANCED_ADAPTER_DELAY: "200",
    });
    expect(
      docker.container("sanctum-zigbee2mqtt")?.options.HostConfig?.Devices,
    ).toEqual([expect.objectContaining({ PathOnHost: conbee })]);
  });

  it("respects a manual choice made while an automatic pick waits to save", async () => {
    const { docker, dev, services, store } = await setup();
    await services.need("zigbee2mqtt", app);
    // The broker's first start has its own save, which the spy below must
    // not catch.
    await services.reconcile();
    await dev.plug(zbt2, "ttyACM0");
    const update = store.update.bind(store);
    vi.spyOn(store, "update").mockImplementationOnce(async (change) => {
      // The scan saw only the ZBT-2. Before its automatic pick is saved,
      // a person plugs in and selects the ConBee.
      await dev.plug(conbee, "ttyACM1");
      await services.chooseZigbeeCoordinator(conbee);
      return update(change);
    });

    await services.reconcile();

    expect(store.current().zigbeeCoordinator?.path).toBe(conbee);
    expect(docker.container("sanctum-zigbee2mqtt")).toBeUndefined();
    // The next scan sees the chosen device and can safely start it.
    await services.reconcile();
    expect(
      docker.container("sanctum-zigbee2mqtt")?.options.HostConfig?.Devices,
    ).toEqual([expect.objectContaining({ PathOnHost: conbee })]);
  });

  it("removes services no app needs, and keeps their data", async () => {
    const { dataDir, docker, dev, services, onChange } = await setup();
    await dev.plug(zbt2, "ttyACM0");
    await services.need("zigbee2mqtt", app);
    await services.reconcile();
    docker.events = [];

    onChange.mockImplementation(() => services.reconcile());
    await services.release("zigbee2mqtt", app);
    await services.reconcile();

    expect(docker.events).toEqual([
      "stop sanctum-zigbee2mqtt",
      "remove sanctum-zigbee2mqtt",
      "stop sanctum-mosquitto",
      "remove sanctum-mosquitto",
    ]);
    expect(docker.images.size).toBe(0);
    expect(docker.volumes.has("sanctum-zigbee2mqtt-data")).toBe(true);
    expect(services.list().map((service) => service.state)).toEqual([
      "off",
      "off",
    ]);
    const saved = JSON.parse(
      await readFile(join(dataDir, "services.json"), "utf8"),
    );
    expect(saved).toMatchObject({ apps: {}, mqttAccounts: {} });
    // It holds the broker passwords.
    expect((await stat(join(dataDir, "services.json"))).mode & 0o777).toBe(
      0o600,
    );
  });

  it("replaces a service the manager brings a new image for", async () => {
    const { docker, dev, services } = await setup();
    await dev.plug(zbt2, "ttyACM0");
    const old = "eclipse-mosquitto:2.0.22";
    docker.load(old, { title: "mosquitto", version: "2.0.22" });
    docker.run({
      name: "sanctum-mosquitto",
      Image: old,
      Labels: {
        "sanctum.managed": "true",
        "sanctum.role": "mosquitto",
        "sanctum.definition": "from-an-older-manager",
      },
    });

    await services.need("zigbee2mqtt", app);
    await services.reconcile();

    expect(docker.imageOf("sanctum-mosquitto")?.tags.has(mosquittoImage)).toBe(
      true,
    );
    // service-image-change.test.ts follows the change from here.
    expect(
      [...docker.images.values()].some((image) => image.tags.has(old)),
    ).toBe(true);
  });

  it("refuses a container with a service's name that it did not make", async () => {
    const { docker, dev, services } = await setup();
    await dev.plug(zbt2, "ttyACM0");
    docker.load("eclipse-mosquitto:latest", { title: "mine", version: "1" });
    const mine = docker.run({
      name: "sanctum-mosquitto",
      Image: "eclipse-mosquitto:latest",
    });

    await services.need("zigbee2mqtt", app);
    await services.reconcile();

    expect(services.status("mosquitto")).toMatchObject({
      state: "failed",
      problem: "Refusing to manage unlabelled sanctum-mosquitto",
    });
    expect(docker.container("sanctum-mosquitto")).toBe(mine);
    // The bridge still starts; it reconnects once there is a broker.
    expect(services.status("zigbee2mqtt")).toMatchObject({ state: "running" });
  });

  it("only lets apps ask for services meant for them", async () => {
    const { services } = await setup();

    await expect(services.need("mosquitto", app)).rejects.toThrow(
      UnknownServiceError,
    );
    await expect(services.need("postgres", app)).rejects.toThrow(
      UnknownServiceError,
    );
    await expect(services.need("zigbee2mqtt", "zigbee")).rejects.toThrow(
      ServiceRequestError,
    );
  });
});

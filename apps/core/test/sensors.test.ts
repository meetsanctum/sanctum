import { describe, expect, it } from "vitest";

import { command, lampsCore, radio, settled } from "./devices-support.js";
import { get, post, type TestCore } from "./support.js";

// Sensors and batteries: a climate sensor's readings are two `sensor`
// capabilities in standard units, which take no commands and which history
// records; its battery is the device's.

const minute = 60_000;

async function sensorCore() {
  const home = await lampsCore();
  await radio.add("sensor-1", "sensor", "Climate sensor");
  await settled();
  const devices = (
    await get(home.core, "/api/devices", { token: home.maya.token })
  ).json();
  const sensor = devices.find(
    (device: { driverName: string }) => device.driverName === "Climate sensor",
  );
  return { ...home, sensor: sensor.id as string };
}

function deviceOf(core: TestCore, token: string, id: string) {
  return get(core, "/api/devices", { token })
    .then((answer) => answer.json())
    .then((devices) => devices.find((each: { id: string }) => each.id === id));
}

describe("a climate sensor", () => {
  it("comes in with a reading for each of its measures and its battery", async () => {
    const { core, maya, sensor } = await sensorCore();

    expect(await deviceOf(core, maya.token, sensor)).toMatchObject({
      // A new device is named after what it is until it is in a room.
      name: "Sensor",
      battery: 87,
      capabilities: [
        {
          id: "temperature",
          kind: "sensor",
          features: { measures: "temperature" },
          state: { value: 21.5 },
          sync: "synced",
        },
        {
          id: "humidity",
          kind: "sensor",
          features: { measures: "humidity" },
          state: { value: 48 },
        },
      ],
    });
  });

  it("is named after its room, as any device is", async () => {
    const { core, maya, sensor } = await sensorCore();
    const office = (
      await post(core, "/api/places/rooms/add", { name: "Office" }, maya)
    ).json();
    await post(
      core,
      "/api/devices/update",
      { id: sensor, roomId: office.id },
      maya,
    );

    expect(await deviceOf(core, maya.token, sensor)).toMatchObject({
      name: "Office sensor",
      roomId: office.id,
    });
  });

  it("keeps its battery until the driver says another, and has none on mains", async () => {
    const { core, maya, sensor, lamp } = await sensorCore();
    await radio.press("sensor-1", { temperature: 22 });
    expect(await deviceOf(core, maya.token, sensor)).toMatchObject({
      battery: 87,
    });
    await radio.press("sensor-1", { battery: 12 });
    expect(await deviceOf(core, maya.token, sensor)).toMatchObject({
      battery: 12,
    });
    expect(await deviceOf(core, maya.token, lamp)).toMatchObject({
      battery: null,
    });
  });

  it("takes no commands", async () => {
    const { core, maya, sensor } = await sensorCore();
    const answer = await command(core, maya.token, sensor, "temperature", {
      value: 30,
    });

    expect(answer.statusCode).toBe(400);
    expect(answer.json()).toMatchObject({ error: "invalid_request" });
    expect(radio.received).toEqual([]);
  });

  it("has each reading recorded and rolled up by history", async () => {
    const { core, maya, sensor } = await sensorCore();
    const noon = core.now().getTime();
    core.advance(2 * minute);
    await radio.press("sensor-1", { temperature: 23.5 });
    await settled();
    core.advance(3 * minute);
    core.history.maintain();

    const params = new URLSearchParams({
      device: sensor,
      capability: "temperature",
      from: new Date(noon).toISOString(),
      period: "5m",
    });
    const answer = (
      await get(core, `/api/history/statistics?${params}`, {
        token: maya.token,
      })
    ).json();
    expect(answer.fields.value).toEqual([
      {
        start: new Date(noon).toISOString(),
        mean: (21.5 * 2 + 23.5 * 3) / 5,
        min: 21.5,
        max: 23.5,
        seconds: 300,
      },
    ]);
  });

  it("refuses a reading that is not a number", async () => {
    const { core } = await sensorCore();
    expect(() =>
      core.devices.report("test.lamps", {
        key: "sensor-1",
        states: { temperature: { value: "warm" } },
      }),
    ).toThrow(/sensor state/);
  });
});

describe("the home's temperature unit", () => {
  it("is Celsius until someone changes it, and every client reads it with the places", async () => {
    const { core, maya } = await lampsCore();
    const places = () =>
      get(core, "/api/places", { token: maya.token }).then((answer) =>
        answer.json(),
      );
    expect((await places()).home.temperatureUnit).toBe("celsius");

    const saved = await post(
      core,
      "/api/places/home/update",
      { temperatureUnit: "fahrenheit" },
      maya,
    );
    expect(saved.json()).toMatchObject({ temperatureUnit: "fahrenheit" });
    expect((await places()).home.temperatureUnit).toBe("fahrenheit");

    const refused = await post(
      core,
      "/api/places/home/update",
      { temperatureUnit: "kelvin" },
      maya,
    );
    expect(refused.statusCode).toBe(400);
  });
});

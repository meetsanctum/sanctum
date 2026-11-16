import { describe, expect, it } from "vitest";

import { lampsCore, openLive, radio, settled } from "./devices-support.js";
import { get, post, type TestCore } from "./support.js";

// What the core asks of SQLite for one press of a room's lights button. A
// statement SQLite has to compile costs far more than running it, so what
// runs for every command and every report is compiled once and kept.

// Every statement the core has SQLite compile from here on, by its text.
function compiled(core: TestCore) {
  const sqlite = core.db.$client;
  const prepare = sqlite.prepare.bind(sqlite);
  const texts: string[] = [];
  sqlite.prepare = ((text: string) => {
    texts.push(text);
    return prepare(text);
  }) as typeof sqlite.prepare;
  return texts;
}

// A room with six lights, all off, and a client following the home.
async function sixLights() {
  const context = await lampsCore();
  const { core, maya, lamp } = context;
  const token = maya.token;
  for (const each of [2, 3, 4, 5, 6]) {
    await radio.add(`lamp-${each}`, "light", `Lamp ${each}`);
  }
  const room = (
    await post(core, "/api/places/rooms/add", { name: "Office" }, { token })
  ).json().id as string;
  const devices = (await get(core, "/api/devices", { token })).json() as {
    id: string;
    type: string;
  }[];
  const lights = devices.filter((device) => device.type === "light");
  expect(lights.map((light) => light.id)).toContain(lamp);
  expect(lights).toHaveLength(6);
  for (const { id } of lights) {
    await post(core, "/api/devices/update", { id, roomId: room }, { token });
  }
  await settled();
  const live = await openLive(core, token);
  const press = (to: "on" | "off") =>
    post(
      core,
      "/api/devices/lights",
      { place: { kind: "room", id: room }, to },
      { token },
    );
  return { ...context, live, press };
}

describe("a press of a room's six lights", () => {
  it("compiles no statement that reads a device or the activity log", async () => {
    const { core, live, press } = await sixLights();
    const texts = compiled(core);
    expect((await press("on")).json()).toMatchObject({ switched: 6 });
    await settled();
    // Every light said it is on, and the client heard each.
    const heard = live.messages.filter(
      (message) =>
        message.type === "device" &&
        (
          message.device as { capabilities: { observed: { on: boolean } }[] }
        ).capabilities.some((capability) => capability.observed.on),
    );
    expect(new Set(heard.map((message) => message.id)).size).toBe(6);
    expect(texts.length).toBeGreaterThan(0);
    expect(
      texts.filter((text) =>
        /^select .* from "(devices|device_capabilities|activity)"/.test(text),
      ),
    ).toEqual([]);
  });
});

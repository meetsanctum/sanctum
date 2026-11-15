import { describeDriver } from "@meetsanctum/app-testkit";
import { afterEach } from "vitest";

import type { EmulatedDevice } from "./emulated-device.js";
import { EmulatedDevice as Device, newKey } from "./emulated-device.js";
import {
  add,
  announce,
  app,
  entitiesOf,
  keyOf,
  migrationsFolder,
  nextMac,
} from "./support.js";

// The capability test suite, with each device played by an emulated ESPHome
// device on a real socket, encrypted with its own key, added as someone
// adds a device the home found.

const devices = new Map<string, EmulatedDevice>();

afterEach(async () => {
  await Promise.all([...devices.values()].map((device) => device.stop()));
  devices.clear();
});

describeDriver({
  app: app(),
  kinds: ["light", "switch", "button", "sensor", "motion", "contact"],
  migrationsFolder,
  async add(kind, core) {
    const device = await Device.start({
      name: `${kind}-${devices.size + 1}`,
      mac: nextMac(),
      psk: newKey(),
      ...entitiesOf(kind),
    });
    devices.set(keyOf(device.options.mac), device);
    await announce(core, device);
    return add(core, device);
  },
  async unplug(key) {
    await devices.get(key)!.unplug();
  },
  async press(key, action) {
    const device = devices.get(key)!;
    // A device presses for the sessions that follow its states.
    await device.followed();
    device.fire(106, action);
  },
});

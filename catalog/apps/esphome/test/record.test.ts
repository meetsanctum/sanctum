import { afterEach, describe, expect, it } from "vitest";

import { secretOf } from "../src/driver.js";
import { EmulatedDevice, newKey } from "./emulated-device.js";
import {
  announce,
  entitiesOf,
  keyOf,
  nextMac,
  startHome,
  timings,
} from "./support.js";

// A device's record says what held as it booted: a key given to it or taken
// off since leaves the record as it was until it restarts. What the device
// answers under the zero key decides how it's listed and how Add goes, and
// what Sanctum's own connections showed as it added and removed it.

let home: Awaited<ReturnType<typeof startHome>>;

afterEach(async () => {
  await home?.stop();
});

const waitingDevice = () =>
  home.plugIn({
    name: "sensor",
    psk: null,
    waiting: true,
    recordAtBoot: true,
    kind: "switch",
  });

const listed = (key: string) =>
  home.core.found.find((each) => each.key === key);

async function listedAs(key: string, description: string) {
  await home.core.until(
    () => listed(key)?.description === description,
    description,
  );
  return listed(key)!;
}

describe("a record from before a key was given or taken off", () => {
  it("adds one removed anyway with the key it was given, its record still saying it waits", async () => {
    home = await startHome();
    const device = await waitingDevice();
    const key = keyOf(device.options.mac);
    await listedAs(key, "Espressif");
    await home.core.add(key, {});
    const given = home.core.secrets.get(secretOf(key));
    await device.unplug();

    await home.core.remove(key, true);
    await device.listen();
    await announce(home.core, device);

    expect(device.sighting().txt.api_provisioning).toBeDefined();
    expect(
      await listedAs(key, "Has the key it was given before"),
    ).toMatchObject({ asks: [] });
    await home.core.add(key, {});
    expect(home.core.registered.has(key)).toBe(true);
    expect(device.keysSent).toEqual([{ key: given, encrypted: true }]);
  });

  it("asks the key of one another app gave a key, refusing to give it one", async () => {
    home = await startHome();
    const device = await waitingDevice();
    const key = keyOf(device.options.mac);
    await listedAs(key, "Espressif");
    // Another app gives it a key, as Home Assistant does once it connects.
    const theirs = newKey();
    device.psk = theirs;
    device.waiting = false;

    expect(await home.core.add(key, {})).toEqual({
      refused: { refusal: "hasKey" },
    });
    expect(device.keysSent).toEqual([]);
    expect(home.core.secrets.size).toBe(0);
    expect(await listedAs(key, "Needs its encryption key")).toMatchObject({
      asks: [{ id: "key" }],
    });

    await home.core.add(key, { key: theirs });
    expect(home.core.registered.has(key)).toBe(true);
    expect(home.core.secrets.get(secretOf(key))).toBe(theirs);
  });

  it("gives a key to one whose key another app took off, its record still saying it has one", async () => {
    home = await startHome();
    const device = await EmulatedDevice.start({
      name: "plug",
      mac: nextMac(),
      psk: newKey(),
      recordAtBoot: true,
      ...entitiesOf("switch"),
    });
    home.devices.push(device);
    // Removed from another app, which took its key off.
    device.psk = null;
    device.waiting = true;
    await announce(home.core, device);
    const key = keyOf(device.options.mac);

    expect(device.sighting().txt.api_encryption).toBeDefined();
    expect(await listedAs(key, "Espressif")).toMatchObject({ asks: [] });
    await home.core.add(key, {});
    expect(home.core.registered.has(key)).toBe(true);
    expect(device.keysSent).toHaveLength(1);
  });

  it("lists one as waiting once its key is taken off, though it booted with it", async () => {
    // As on a real device: given its key, restarted, so its record says it
    // has one, then removed, which takes the key off.
    home = await startHome();
    const device = await waitingDevice();
    const key = keyOf(device.options.mac);
    await listedAs(key, "Espressif");
    await home.core.add(key, {});
    await device.followed();
    const greeted = device.greeted;
    device.reboot();
    await announce(home.core, device);
    await home.core.until(
      () => device.greeted > greeted && device.activeConnections === 1,
      "connected again",
    );
    await device.followed();

    await home.core.remove(key);

    expect(device.sighting().txt.api_encryption).toBeDefined();
    await home.core.until(() => device.psk === null, "its key off");
    expect(
      await listedAs(key, "Gets an encryption key of its own"),
    ).toMatchObject({ asks: [] });
    await home.core.add(key, {});
    expect(home.core.registered.has(key)).toBe(true);
    expect(device.keysSent).toHaveLength(3);
  });

  it("isn't taken for one without encryption when it's too busy to answer", async () => {
    home = await startHome();
    const device = await EmulatedDevice.start({
      name: "sensor",
      mac: nextMac(),
      psk: null,
      waiting: true,
      ...entitiesOf("switch"),
    });
    home.devices.push(device);
    // Its connections are all in use, so it closes the zero key's greeting,
    // and the library greets it again in the clear.
    device.closesNext = 1;
    await announce(home.core, device);
    const key = keyOf(device.options.mac);

    // Asked again once it may answer.
    expect(await listedAs(key, "Espressif")).toMatchObject({ asks: [] });
    expect(listed(key)?.description).not.toBe("Not encrypted");
    await home.core.add(key, {});
    expect(device.keysSent).toEqual([
      { key: home.core.secrets.get(secretOf(key)), encrypted: true },
    ]);
  });

  it("asks one whose window closed again, as turning it off and on announces the same record", async () => {
    home = await startHome();
    const device = await waitingDevice();
    device.windowClosed = true;
    await announce(home.core, device);
    const key = keyOf(device.options.mac);
    await listedAs(key, "Turn it off and on again to add it");

    // Turned off and on again: its window opens, its record the same.
    device.windowClosed = false;
    device.reboot();

    expect(await listedAs(key, "Espressif")).toMatchObject({ asks: [] });
    expect(timings.askAgainMs).toBeLessThan(1_000);
    await home.core.add(key, {});
    expect(home.core.registered.has(key)).toBe(true);
  });
});

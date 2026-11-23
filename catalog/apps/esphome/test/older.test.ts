import type { DeviceInfo } from "esphome-client";
import { afterEach, describe, expect, it } from "vitest";

import { givenOf, isOlderFirmware, secretOf, setupOf } from "../src/keys.js";
import type { Announced } from "../src/sightings.js";
import type { EmulatedOptions } from "./emulated-device.js";
import { announce, keyOf, startHome } from "./support.js";

// Firmware from before ESPHome 2026.7 built with encryption can't wait for
// a key: it takes a first one only in the clear. It gets a throwaway setup
// key that way, then at once its own key over the connection the setup key
// encrypts, so its own key never crosses the network in the clear, and the
// device is never talked to in the clear again. It's told apart only as
// someone adds it, every sign agreeing.

let home: Awaited<ReturnType<typeof startHome>>;

afterEach(async () => {
  await home?.stop();
});

type OlderOptions = Pick<EmulatedOptions, "clears" | "maxConnections"> & {
  kind?: "button" | "switch";
};

const olderDevice = (options: OlderOptions = {}) =>
  home.plugIn({
    name: "voice",
    project: "Nabu Casa.Home Assistant Voice PE",
    psk: null,
    older: true,
    version: "2026.6.0",
    kind: "button",
    ...options,
  });

const card = (key: string) => home.core.found.find((each) => each.key === key);

// Listed by who made it, asking nothing: how it gets its key isn't the
// household's business.
const older = { description: "Nabu Casa", asks: [] };

async function addOlder(options?: OlderOptions) {
  const device = await olderDevice(options);
  const key = keyOf(device.options.mac);
  await home.core.until(() => card(key) !== undefined, "listed");
  await home.core.add(key, {});
  await home.core.until(
    () => home.core.availability.get(key) === "online",
    "online under its own key",
  );
  return { device, key };
}

describe("older firmware", () => {
  it("is listed by what Add does, and isn't asked until someone adds it", async () => {
    home = await startHome();
    const device = await olderDevice();
    const key = keyOf(device.options.mac);
    await home.core.until(() => card(key) !== undefined, "listed");

    expect(card(key)).toMatchObject(older);
    expect(device.connections).toBe(0);
  });

  it("takes a device once seen waiting for a key as older firmware once it announces an older version", async () => {
    home = await startHome();
    const device = await home.plugIn({ psk: null, waiting: true });
    const key = keyOf(device.options.mac);
    await home.core.until(
      () => card(key)?.description === "Espressif",
      "seen under the zero key",
    );
    device.waiting = false;
    device.options.older = true;
    device.options.version = "2026.6.0";
    device.reboot();
    // Flashed with firmware from before 2026.7, as its record now says.
    await announce(home.core, device);

    await home.core.add(key, {});
    expect(device.keysSent.map((each) => each.encrypted)).toEqual([
      false,
      true,
    ]);
  });

  it("gets a setup key in the clear, then its own encrypted, and is never in the clear again", async () => {
    home = await startHome();
    const { device, key } = await addOlder();

    // One connection in the clear, the one its setup key went over.
    expect(device.plainGreetings).toBe(1);
    const own = home.core.secrets.get(secretOf(key));
    expect(own).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(home.core.secrets.get(givenOf(key))).toBe("setup");
    expect(home.core.secrets.has(setupOf(key))).toBe(false);
    expect(device.keysSent).toHaveLength(2);
    const [setup, mine] = device.keysSent;
    expect(setup).toMatchObject({ encrypted: false });
    expect(mine).toEqual({ key: own, encrypted: true });
    expect(setup!.key).not.toBe(own);
    expect(device.psk).toBe(own);
    expect(
      await home.core.call("esphome.device", { device: `device:${key}` }),
    ).toMatchObject({ encrypted: true, firstKey: "setup" });

    // Restarted, it's reached under its own key, never in the clear.
    const plain = device.plainGreetings;
    device.reboot();
    await announce(home.core, device);
    await home.core.until(() => device.greeted > 3, "back after a restart");
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online again",
    );
    expect(device.plainGreetings).toBe(plain);
    expect(home.core.problems.has(key)).toBe(false);
  });

  it("gets its own key over the setup key it took while the answer was lost", async () => {
    home = await startHome();
    const device = await olderDevice();
    const key = keyOf(device.options.mac);
    await home.core.until(() => card(key) !== undefined, "listed");
    device.losesAnswerToKey = 1;

    await expect(home.core.add(key, {})).rejects.toThrow();
    const setup = home.core.secrets.get(setupOf(key));
    expect(device.psk).toBe(setup);

    await home.core.add(key, {});
    expect(home.core.registered.has(key)).toBe(true);
    expect(device.keysSent.map((each) => each.encrypted)).toEqual([
      false,
      true,
    ]);
    expect(device.psk).toBe(home.core.secrets.get(secretOf(key)));
    expect(home.core.secrets.has(setupOf(key))).toBe(false);
  });

  it("is added with its own key when it took it while the answer was lost", async () => {
    home = await startHome();
    const device = await olderDevice();
    const key = keyOf(device.options.mac);
    await home.core.until(() => card(key) !== undefined, "listed");
    device.losesAnswerToKey = 2;

    await expect(home.core.add(key, {})).rejects.toThrow();
    const own = home.core.secrets.get(secretOf(key));
    expect(device.psk).toBe(own);

    await home.core.add(key, {});
    expect(home.core.registered.has(key)).toBe(true);
    expect(device.keysSent).toHaveLength(2);
    expect(home.core.secrets.has(setupOf(key))).toBe(false);
    expect(
      await home.core.call("esphome.device", { device: `device:${key}` }),
    ).toMatchObject({ encrypted: true, firstKey: "setup" });
  });

  it("is sent a new setup key on another Add after refusing one, never the kept one again", async () => {
    home = await startHome();
    const device = await olderDevice();
    const key = keyOf(device.options.mac);
    await home.core.until(() => card(key) !== undefined, "listed");
    device.refusesKeys = true;

    await expect(home.core.add(key, {})).rejects.toThrow();
    expect(home.core.registered.has(key)).toBe(false);
    device.refusesKeys = false;
    await home.core.add(key, {});

    const clear = device.keysSent.filter((each) => !each.encrypted);
    expect(clear).toHaveLength(2);
    expect(clear[0]!.key).not.toBe(clear[1]!.key);
    expect(device.psk).toBe(home.core.secrets.get(secretOf(key)));
  });

  it("never gets a kept key in the clear, after it was removed anyway and reset", async () => {
    home = await startHome();
    const { device, key } = await addOlder();
    const kept = home.core.secrets.get(secretOf(key));
    await home.core.remove(key, true);
    expect(home.core.secrets.get(secretOf(key))).toBe(kept);

    // Reset to no key, it greets in the clear again.
    device.psk = null;
    device.reboot();
    await announce(home.core, device);
    // Its kept key, tried encrypted, no longer works, and it answers as
    // older firmware: Add says so, and the card does too.
    expect(await home.core.add(key, {})).toEqual({
      refused: { refusal: "changed" },
    });
    expect(card(key)).toMatchObject(older);
    await home.core.add(key, {});

    expect(home.core.registered.has(key)).toBe(true);
    for (const each of device.keysSent) {
      if (each.key === kept) expect(each.encrypted).toBe(true);
    }
    expect(
      device.keysSent.filter((each) => !each.encrypted).map((each) => each.key),
    ).not.toContain(kept);
  });

  it("keeps how the device got its key when it is removed anyway and re-added", async () => {
    home = await startHome();
    const { device, key } = await addOlder();
    await home.core.remove(key, true);
    await home.core.add(key, {});

    expect(device.keysSent).toHaveLength(2);
    expect(
      await home.core.call("esphome.device", { device: `device:${key}` }),
    ).toMatchObject({ encrypted: true, firstKey: "setup" });
  });

  it("has its key taken off when it's removed, and is older firmware again", async () => {
    home = await startHome();
    const { device, key } = await addOlder();

    await home.core.remove(key);
    expect(device.keysSent.at(-1)).toEqual({ key: "", encrypted: true });
    await home.core.until(() => device.psk === null, "its key off");
    expect(device.waiting).toBe(false);
    await announce(home.core, device);
    await home.core.until(() => card(key) !== undefined, "listed again");
    expect(card(key)).toMatchObject(older);
    // Added again, it gets a setup key in the clear, then its own encrypted.
    const sent = device.keysSent.length;
    await home.core.add(key, {});
    expect(device.keysSent.slice(sent).map((each) => each.encrypted)).toEqual([
      false,
      true,
    ]);
  });

  it("finishes removing a key it cleared while the answer was lost", async () => {
    home = await startHome();
    const { device, key } = await addOlder({ maxConnections: 1 });
    // The discovery record still says it has a key after clearing it.
    await announce(home.core, device);
    device.losesNextAnswer = true;

    await expect(home.core.remove(key)).rejects.toThrow();
    expect(device.psk).toBeNull();
    const sent = device.keysSent.length;

    await home.core.remove(key);
    expect(home.core.registered.has(key)).toBe(false);
    expect(home.core.secrets.size).toBe(0);
    expect(device.keysSent).toHaveLength(sent);
    expect(card(key)).toMatchObject(older);
  });

  it("keeps its key when its firmware can't clear one, unless removed anyway", async () => {
    home = await startHome();
    const device = await olderDevice({ clears: false });
    const key = keyOf(device.options.mac);
    await home.core.until(() => card(key) !== undefined, "listed");
    await home.core.add(key, {});

    await expect(home.core.remove(key)).rejects.toThrow();
    expect(home.core.registered.has(key)).toBe(true);
    await home.core.remove(key, true);
    expect(home.core.registered.has(key)).toBe(false);
    expect(device.psk).toBe(home.core.secrets.get(secretOf(key)));
  });
});

describe("repairs that ask nothing", () => {
  it("encrypts a device with one connection slot, which works meanwhile", async () => {
    home = await startHome();
    const { device, key } = await addOlder({
      kind: "switch",
      maxConnections: 1,
    });
    // As a device added before it could be given a key: no key on either side.
    device.psk = null;
    home.core.secrets.delete(secretOf(key));
    home.core.secrets.delete(givenOf(key));
    device.reboot();
    await announce(home.core, device);
    await home.core.until(
      () => home.core.problems.get(key)?.id === "notEncrypted",
      "not encrypted",
    );

    // Not encrypted is a problem to repair, not a reason to stop using it.
    await home.core.command(key, "switch-relay", "switch", { on: true });
    await home.core.until(() => device.commands.length === 1, "the command");

    expect(await home.core.repair(key, {})).toBeUndefined();
    await home.core.until(
      () => !home.core.problems.has(key),
      "encrypted, its problem gone",
    );
    expect(device.psk).toBe(home.core.secrets.get(secretOf(key)));
    expect(device.keysSent.at(-1)).toMatchObject({ encrypted: true });
    await home.core.command(key, "switch-relay", "switch", { on: false });
    await home.core.until(() => device.commands.length === 2, "the command");
  });

  it("finishes a repair whose answer was lost, sending nothing in the clear again", async () => {
    home = await startHome();
    const { device, key } = await addOlder();
    device.psk = null;
    home.core.secrets.delete(secretOf(key));
    home.core.secrets.delete(givenOf(key));
    device.reboot();
    await announce(home.core, device);
    await home.core.until(
      () => home.core.problems.get(key)?.id === "notEncrypted",
      "not encrypted",
    );
    const sent = device.keysSent.length;
    // It takes its setup key, then its own, but the answer to its own is lost.
    device.losesAnswerToKey = sent + 2;

    await expect(home.core.repair(key, {})).rejects.toThrow();
    await home.core.repair(key, {});
    await home.core.until(
      () => !home.core.problems.has(key),
      "encrypted, its problem gone",
    );
    const repairs = device.keysSent.slice(sent);
    expect(repairs.filter((each) => !each.encrypted)).toHaveLength(1);
    expect(device.psk).toBe(home.core.secrets.get(secretOf(key)));
    expect(home.core.secrets.has(setupOf(key))).toBe(false);
  });

  it.each([false, true])(
    "can remove after a repair left the setup key on the device (Remove anyway: %s)",
    async (force) => {
      home = await startHome();
      const { device, key } = await addOlder();
      device.psk = null;
      device.reboot();
      await announce(home.core, device);
      await home.core.until(
        () => home.core.problems.get(key)?.id === "keyLost",
        "lost its key",
      );
      device.losesNextAnswer = true;

      await expect(home.core.repair(key, {})).rejects.toThrow();
      const setup = home.core.secrets.get(setupOf(key));
      expect(device.psk).toBe(setup);

      await home.core.remove(key, force);
      if (force) {
        expect(home.core.secrets.get(setupOf(key))).toBe(setup);
        const sent = device.keysSent.length;
        device.reboot();
        await announce(home.core, device);
        await home.core.add(key, {});
        expect(device.keysSent.slice(sent)).toEqual([
          { key: home.core.secrets.get(secretOf(key)), encrypted: true },
        ]);
        expect(home.core.secrets.has(setupOf(key))).toBe(false);
      } else {
        await home.core.until(() => device.psk === null, "its setup key off");
        expect(device.keysSent.at(-1)).toEqual({ key: "", encrypted: true });
        expect(home.core.secrets.size).toBe(0);
      }
    },
  );

  it("gives older firmware that lost its key a new one", async () => {
    home = await startHome();
    const { device, key } = await addOlder({ maxConnections: 1 });
    const before = home.core.secrets.get(secretOf(key));
    // Reset, it lost the key Sanctum gave it.
    device.psk = null;
    device.reboot();
    await announce(home.core, device);
    await home.core.until(
      () => home.core.problems.get(key)?.id === "keyLost",
      "lost its key",
    );

    expect(await home.core.repair(key, {})).toBeUndefined();
    await home.core.until(
      () =>
        !home.core.problems.has(key) &&
        home.core.availability.get(key) === "online",
      "back under a new key",
    );
    const after = home.core.secrets.get(secretOf(key));
    expect(after).not.toBe(before);
    expect(device.psk).toBe(after);
  });

  it.each([false, true])(
    "gives a reset device a new key over the zero key (its window closed: %s)",
    async (isWindowClosed) => {
      home = await startHome();
      const device = await home.plugIn({ psk: null, waiting: true });
      const key = keyOf(device.options.mac);
      await home.core.until(() => card(key) !== undefined, "listed");
      await home.core.add(key, {});
      await home.core.until(
        () => home.core.availability.get(key) === "online",
        "online",
      );
      device.psk = null;
      device.waiting = true;
      device.windowClosed = isWindowClosed;
      device.reboot();
      await announce(home.core, device);
      await home.core.until(
        () => home.core.problems.get(key)?.id === "keyLost",
        "lost its key",
      );

      device.windowClosed = false;
      await home.core.repair(key, {});
      await home.core.until(
        () => !home.core.problems.has(key),
        "back under a new key",
      );
      expect(device.keysSent.every((each) => each.encrypted)).toBe(true);
      expect(device.psk).toBe(home.core.secrets.get(secretOf(key)));
    },
  );
});

describe("telling older firmware apart", () => {
  const record: Announced = {
    mac: "aa:bb:cc:00:00:01",
    name: "voice",
    addresses: ["192.168.1.2"],
    port: 6053,
    encryption: "older",
    version: "2026.6.0",
    projectName: null,
  };
  const info = {
    macAddress: "AA:BB:CC:00:00:01",
    esphomeVersion: "2026.6.0",
    apiEncryptionSupported: true,
  } as DeviceInfo;

  it("takes every sign agreeing", () => {
    expect(isOlderFirmware(record, info, false)).toBe(true);
    expect(
      isOlderFirmware(record, { ...info, esphomeVersion: "2026.6.0b1" }, false),
    ).toBe(true);
  });

  it("refuses when any one sign disagrees", () => {
    expect(
      isOlderFirmware({ ...record, encryption: "waiting" }, info, false),
    ).toBe(false);
    expect(isOlderFirmware(record, info, true)).toBe(false);
    expect(
      isOlderFirmware(
        record,
        { ...info, apiEncryptionSupported: false },
        false,
      ),
    ).toBe(false);
    // A busy 2026.7 device answered in the clear says it can wait for a key.
    expect(
      isOlderFirmware(
        record,
        { ...info, apiEncryptionProvisionable: true } as DeviceInfo,
        false,
      ),
    ).toBe(false);
    expect(
      isOlderFirmware(record, { ...info, esphomeVersion: "2026.10.2" }, false),
    ).toBe(false);
    expect(
      isOlderFirmware(
        record,
        { ...info, esphomeVersion: "2026.6broken" },
        false,
      ),
    ).toBe(false);
    expect(
      isOlderFirmware(
        record,
        { ...info, esphomeVersion: undefined } as DeviceInfo,
        false,
      ),
    ).toBe(false);
    expect(
      isOlderFirmware({ ...record, version: "2026.7.0" }, info, false),
    ).toBe(false);
  });
});

import { afterEach, describe, expect, it } from "vitest";

import { connectOnce } from "../src/connection.js";
import { secretOf } from "../src/driver.js";
import { givenOf, zeroKey } from "../src/keys.js";
import { newKey } from "./emulated-device.js";
import { add, announce, keyOf, startHome, timings } from "./support.js";

// Keys Sanctum gives: a device built to be given its key later gets 32
// random bytes of its own, only ever over a connection encrypted with the
// zero key, kept before they're sent, and the device is added once it's back
// under that key. Removing it takes the key off again, or, removed anyway
// while out of reach, leaves the key on it and kept, so finding it again
// adds it as it was. A key a device was flashed with is never touched.

let home: Awaited<ReturnType<typeof startHome>>;

afterEach(async () => {
  await home?.stop();
});

const waitingDevice = () =>
  home.plugIn({ name: "sensor", psk: null, waiting: true, kind: "switch" });

describe("a device waiting for a key", () => {
  it("gets one of its own, sent encrypted and kept before it's sent", async () => {
    home = await startHome();
    const device = await waitingDevice();
    const key = await add(home.core, device);

    const given = home.core.secrets.get(secretOf(key));
    expect(given).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(home.core.secrets.get(givenOf(key))).toBe("yes");
    expect(device.keysSent).toEqual([{ key: given, encrypted: true }]);
    expect(device.psk).toBe(given);
    expect(device.waiting).toBe(false);
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online under its key",
    );
    expect(
      await home.core.call("esphome.device", { device: `device:${key}` }),
    ).toMatchObject({ encrypted: true });
  });

  it("is given the same key again after its answer was lost, tried first", async () => {
    home = await startHome();
    const device = await waitingDevice();
    const key = keyOf(device.options.mac);
    device.losesNextAnswer = true;

    await expect(home.core.add(key, {})).rejects.toThrow();
    const given = home.core.secrets.get(secretOf(key));
    expect(given).toBeDefined();
    expect(home.core.registered.has(key)).toBe(false);

    // It took the key, so it now announces one, which adding tries first.
    await announce(home.core, device);
    expect(home.core.found.find((each) => each.key === key)).toMatchObject({
      description: "Has the key it was given before",
      asks: [],
    });
    await home.core.add(key, {});

    expect(home.core.registered.has(key)).toBe(true);
    expect(device.keysSent).toEqual([{ key: given, encrypted: true }]);
  });

  it("says when it stopped waiting for a key, keeping nothing", async () => {
    home = await startHome();
    const device = await waitingDevice();
    device.windowClosed = true;

    expect(await home.core.add(keyOf(device.options.mac), {})).toEqual({
      refused: { refusal: "notWaiting" },
    });
    expect(home.core.secrets.size).toBe(0);
    expect(device.keysSent).toEqual([]);
  });

  it("isn't taken as no longer waiting when it parts for no reason", async () => {
    home = await startHome();
    const device = await waitingDevice();
    const key = keyOf(device.options.mac);
    await home.core.until(
      () =>
        home.core.found.find((each) => each.key === key)?.description ===
        "Espressif",
      "who made it",
    );
    // As while it applies a key or shuts down: it asks to part, saying no why.
    device.partsWithoutReason = true;

    await expect(home.core.add(key, {})).rejects.toThrow("It didn't answer");
    expect(device.keysSent).toEqual([]);
    expect(home.core.secrets.size).toBe(0);

    await home.core.add(key, {});
    expect(home.core.registered.has(key)).toBe(true);
  });

  it("says, under the zero key, that it can be given a key", async () => {
    home = await startHome();
    const device = await waitingDevice();
    const keyed = await home.plugIn({
      name: "lamp",
      psk: newKey(),
      kind: "light",
    });
    const reach = (each: typeof device) => ({
      mac: keyOf(each.options.mac),
      address: { host: each.host, port: each.port },
      timings,
    });

    const waiting = await connectOnce({ ...reach(device), key: zeroKey });
    if (!("session" in waiting)) throw new Error("no session");
    waiting.session.client.disconnect();
    expect(waiting.session.info.apiEncryptionProvisionable).toBe(true);

    const own = await connectOnce({ ...reach(keyed), key: keyed.psk });
    if (!("session" in own)) throw new Error("no session");
    own.session.client.disconnect();
    expect(own.session.info.apiEncryptionSupported).toBe(true);
    expect(own.session.info.apiEncryptionProvisionable).toBeUndefined();
  });

  it("doesn't take one when its window closes as it's given it", async () => {
    home = await startHome();
    const device = await waitingDevice();
    const key = keyOf(device.options.mac);
    // Once who made it is read, its next greeting is Add's.
    await home.core.until(
      () =>
        home.core.found.find((each) => each.key === key)?.description ===
        "Espressif",
      "who made it",
    );
    device.closesWindowAfterHello = true;

    await expect(home.core.add(key, {})).rejects.toThrow();
    expect(device.keysSent).toHaveLength(1);
    expect(device.waiting).toBe(true);
    expect(device.psk).toBeNull();

    expect(await home.core.add(key, {})).toEqual({
      refused: { refusal: "notWaiting" },
    });
  });

  it.each([
    {
      reply: "completes its greeting",
      isWindowClosed: false,
      error: "It can't be given a key",
    },
    {
      reply: "reports a closed window",
      isWindowClosed: true,
      error: "It didn't answer",
    },
  ])(
    "rejects a plaintext provisioning connection when the device $reply",
    async ({ isWindowClosed, error }) => {
      home = await startHome();
      const device = await home.plugIn({ name: "sensor", psk: null });
      device.windowClosed = isWindowClosed;
      const record = device.sighting();
      await home.core.discovered({
        found: [
          {
            ...record,
            txt: {
              ...record.txt,
              api_encryption_supported: "Noise_NNpsk0_25519_ChaChaPoly_SHA256",
              api_provisioning: "zero_psk",
            },
          },
        ],
        lost: [],
      });

      await expect(
        home.core.add(keyOf(device.options.mac), {}),
      ).rejects.toThrow(error);
      expect(device.keysSent).toEqual([]);
      expect(home.core.secrets.size).toBe(0);
    },
  );
});

describe("removing a device", () => {
  it("takes the key Sanctum gave it off, so it waits for one again", async () => {
    home = await startHome();
    const device = await waitingDevice();
    const key = await add(home.core, device);
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online",
    );

    await home.core.remove(key);

    expect(device.keysSent.at(-1)).toEqual({ key: "", encrypted: true });
    await home.core.until(() => device.waiting, "its key applied");
    expect(home.core.secrets.size).toBe(0);
    await announce(home.core, device);
    expect(home.core.found.map((each) => each.key)).toEqual([key]);
    expect(home.core.problems.has(key)).toBe(false);
  });

  it("finds the key off already when removed again after a lost answer", async () => {
    home = await startHome();
    const device = await waitingDevice();
    const key = await add(home.core, device);
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online",
    );
    device.losesNextAnswer = true;

    await expect(home.core.remove(key)).rejects.toThrow();
    expect(home.core.registered.has(key)).toBe(true);
    await announce(home.core, device);
    await home.core.remove(key);

    expect(home.core.registered.has(key)).toBe(false);
    expect(device.waiting).toBe(true);
    expect(home.core.secrets.size).toBe(0);
  });

  it("anyway, out of reach, leaves its key on it and kept, and adds it as it was", async () => {
    home = await startHome();
    const device = await waitingDevice();
    const key = await add(home.core, device);
    const given = home.core.secrets.get(secretOf(key));
    await device.unplug();

    await home.core.remove(key, true);

    expect(home.core.secrets.get(secretOf(key))).toBe(given);
    await device.listen();
    await announce(home.core, device);
    expect(home.core.found.find((each) => each.key === key)).toMatchObject({
      asks: [],
    });
    await home.core.add(key, {});
    expect(home.core.registered.has(key)).toBe(true);
    expect(device.keysSent).toEqual([{ key: given, encrypted: true }]);
  });

  it("anyway, then reflashed without encryption, adds it as one, forgetting the key", async () => {
    home = await startHome();
    const device = await waitingDevice();
    const key = await add(home.core, device);
    await device.unplug();
    await home.core.remove(key, true);

    device.psk = null;
    device.waiting = false;
    await device.listen();
    await announce(home.core, device);
    await home.core.add(key, {});

    expect(home.core.registered.has(key)).toBe(true);
    expect(home.core.secrets.size).toBe(0);
  });

  it("anyway, then reflashed with another key, asks for that key", async () => {
    home = await startHome();
    const device = await waitingDevice();
    const key = await add(home.core, device);
    await device.unplug();
    await home.core.remove(key, true);

    const flashed = newKey();
    device.psk = flashed;
    await device.listen();
    await announce(home.core, device);
    expect(await home.core.add(key, {})).toEqual({
      refused: { refusal: "keyChanged" },
    });
    expect(
      home.core.found
        .find((each) => each.key === key)
        ?.asks.map((each) => each.id),
    ).toEqual(["key"]);
    await home.core.add(key, { key: flashed });

    expect(home.core.registered.has(key)).toBe(true);
    expect(home.core.secrets.get(secretOf(key))).toBe(flashed);
    expect(home.core.secrets.has(givenOf(key))).toBe(false);
  });

  it("never touches a key it was flashed with", async () => {
    home = await startHome();
    const device = await home.plugIn();
    const flashed = device.psk;
    const key = await add(home.core, device);
    await home.core.until(
      () => home.core.availability.get(key) === "online",
      "online",
    );

    await home.core.remove(key);

    expect(device.keysSent).toEqual([]);
    expect(device.psk).toBe(flashed);
  });
});

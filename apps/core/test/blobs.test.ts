import {
  blobKeptMs,
  maxAppBlobBytes,
  maxAppBlobs,
  maxBlobBytes,
  type DeviceInfo,
} from "@meetsanctum/app-sdk";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { createBlobs } from "../src/blobs/blobs.js";
import { lampsCore, radio, settled } from "./devices-support.js";
import { get, post, testCore } from "./support.js";

// Blobs: pictures a driver hands the core, kept in memory by their hash for
// clients to fetch while a device's state names them.

const minute = 60_000;
// Bytes that begin as a 1 by 1 PNG does, which is all the core reads of
// them; what follows tells one from another.
const png = (...rest: number[]) =>
  Uint8Array.from([
    ...[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    ...[0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 1, 0, 0, 0, 1],
    ...[8, 2, 0, 0, 0, 0, 0, 0, 0],
    ...[0, 0, 0, rest.length, 0x49, 0x44, 0x41, 0x54],
    ...rest,
    0,
    0,
    0,
    0,
  ]);

// A media player of the app's whose state names a picture, as a device's
// change brings it to the blobs; null names none.
function player(app: string, hash: string | null) {
  return {
    id: `player-${app}`,
    driver: app,
    capabilities: [
      { kind: "media", observed: hash ? { media: { artwork: hash } } : {} },
    ],
  } as unknown as DeviceInfo;
}

// Names each hash by a device of the app's of its own.
function namer(blobs: ReturnType<typeof createBlobs>, app: string) {
  let devices = 0;
  return (hash: string) => {
    devices += 1;
    blobs.deviceChanged({
      id: `${app}-${devices}`,
      before: null,
      after: { ...player(app, hash), id: `${app}-${devices}` },
    });
  };
}

async function pictureCore() {
  const home = await lampsCore({ origin: "official" });
  await radio.add("box-1", "media", "Living room box");
  await settled();
  return home;
}

describe("a driver's picture", () => {
  it("is kept by its hash and given to clients as it was handed over", async () => {
    const { core, maya } = await pictureCore();
    const hash = await radio.picture("box-1", "image/png", png(1, 2, 3));
    await settled();

    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const answer = await get(core, `/api/blobs/${hash}`, { token: maya.token });
    expect(answer.statusCode).toBe(200);
    expect(answer.headers["content-type"]).toBe("image/png");
    expect(answer.headers["cache-control"]).toContain("immutable");
    expect(answer.headers.vary).toBe("Origin, Authorization");
    expect(answer.headers["x-content-type-options"]).toBe("nosniff");
    expect(Uint8Array.from(answer.rawPayload)).toEqual(png(1, 2, 3));
    // The same bytes have the same name.
    expect(await radio.picture("box-1", "image/png", png(1, 2, 3))).toBe(hash);
  });

  it("is only for a client with a token, and a name that isn't one is not found", async () => {
    const { core, maya } = await pictureCore();
    const hash = await radio.picture("box-1", "image/png", png(4));
    expect((await get(core, `/api/blobs/${hash}`)).statusCode).toBe(401);
    for (const name of ["a".repeat(64), "not-a-hash"]) {
      const answer = await get(core, `/api/blobs/${name}`, {
        token: maya.token,
      });
      expect(answer.statusCode).toBe(404);
      expect(answer.headers["cache-control"]).toBe("no-store");
    }
  });

  it("is refused when it isn't a picture of its type, or is too large", async () => {
    await pictureCore();
    await expect(radio.picture("box-1", "image/jpeg", png(1))).rejects.toThrow(
      /must be a still image\/jpeg/,
    );
    const tooLarge = new Uint8Array(maxBlobBytes + 1);
    tooLarge.set(png());
    await expect(radio.picture("box-1", "image/png", tooLarge)).rejects.toThrow(
      /cannot exceed 700 KB/,
    );
    // A small file that says it is 5000 by 5000 px.
    const huge = png(1);
    new DataView(huge.buffer).setUint32(16, 5000);
    new DataView(huge.buffer).setUint32(20, 5000);
    await expect(radio.picture("box-1", "image/png", huge)).rejects.toThrow(
      /4096 px on each side/,
    );
  });

  it("lasts while a device's state names it and a minute after", async () => {
    const { core, maya } = await pictureCore();
    const first = await radio.picture("box-1", "image/png", png(5));
    await settled();
    core.advance(2 * blobKeptMs);
    core.blobs.sweep();
    const shown = (hash: string) =>
      get(core, `/api/blobs/${hash}`, { token: maya.token }).then(
        (answer) => answer.statusCode,
      );
    // Still named by the player's state.
    expect(await shown(first)).toBe(200);

    await radio.picture("box-1", "image/png", png(6));
    await settled();
    core.advance(blobKeptMs - 1);
    core.blobs.sweep();
    expect(await shown(first)).toBe(200);
    core.advance(1);
    core.blobs.sweep();
    expect(await shown(first)).toBe(404);
    expect(blobKeptMs).toBe(minute);
  });

  it("goes with the driver and cannot be restored by its stop hook", async () => {
    const { core, maya } = await pictureCore();
    const bytes = png(7);
    const hash = await radio.picture("box-1", "image/png", bytes);
    const deviceChanged = vi.spyOn(core.blobs, "deviceChanged");
    let upload: Promise<unknown> | undefined;
    radio.onStop = async (ctx) => {
      upload = ctx.blobs.put({ type: "image/png", data: bytes });
      await upload.catch(() => undefined);
    };

    expect(
      (await post(core, "/api/apps/test.lamps/remove", {}, maya)).statusCode,
    ).toBe(200);
    expect(upload).toBeDefined();
    await expect(upload).rejects.toThrow(/cannot keep/);
    expect((await get(core, `/api/blobs/${hash}`, maya)).statusCode).toBe(404);
    expect(deviceChanged).toHaveBeenCalledWith(
      expect.objectContaining({
        before: expect.objectContaining({ driverName: "Living room box" }),
        after: null,
      }),
    );
  });

  it("follows a driver's stored artwork again when the driver is added back", async () => {
    const { core, maya } = await pictureCore();
    const driver = "test.lamps";
    const manifest = core.apps.manifest(driver)!;
    const bytes = png(10);
    const hash = await radio.picture("box-1", "image/png", bytes);
    await settled();
    expect(
      (await post(core, `/api/apps/${driver}/remove`, {}, maya)).statusCode,
    ).toBe(200);
    await core.stop();

    const restarted = await testCore({ dataDir: core.dataDir });
    expect(restarted.blobs.put(driver, "image/png", bytes)).toBe(hash);
    restarted.advance(2 * blobKeptMs);
    restarted.blobs.sweep();
    expect(restarted.blobs.get(hash)).toBeNull();

    vi.spyOn(restarted.availableApps, "find").mockResolvedValue({
      app: {
        id: driver,
        name: manifest.name,
        version: manifest.version,
        summary: manifest.summary,
        icon: manifest.icon,
        requests: manifest.permissions,
        memory: manifest.runtime.memory,
        data: manifest.runtime.data,
        adds: {
          devices: true,
          widgets: 0,
          roomSections: 0,
          devicePages: 0,
          pieces: 0,
        },
        shortfalls: [],
      },
      pkg: { origin: "official", apart: { manifest, digest: "", folder: "" } },
    });
    // The test core records the add and reveals the devices without an installer.
    const response = await post(
      restarted,
      "/api/apps/add",
      { id: driver, version: manifest.version },
      maya,
    );
    expect(response.json()).toEqual({ error: "app_failed" });
    expect(restarted.blobs.put(driver, "image/png", bytes)).toBe(hash);
    restarted.advance(2 * blobKeptMs);
    restarted.blobs.sweep();
    expect(restarted.blobs.get(hash)).not.toBeNull();
  });

  it("keeps the picture a stored state names once the core restarts and its driver puts it again", async () => {
    const { core } = await pictureCore();
    const bytes = png(11);
    const hash = await radio.picture("box-1", "image/png", bytes);
    await settled();
    await core.stop();

    // The driver puts the same bytes, and its state already names them, so
    // no change follows: only the devices the core read as it started do.
    const restarted = await testCore({ dataDir: core.dataDir });
    expect(restarted.blobs.put("test.lamps", "image/png", bytes)).toBe(hash);
    restarted.advance(2 * blobKeptMs);
    restarted.blobs.sweep();
    expect(restarted.blobs.get(hash)).not.toBeNull();
  });

  it("keeps pictures named by every media capability until the last device moves on", async () => {
    const { core } = await pictureCore();
    const driver = "test.lamps";
    const first = core.blobs.put(driver, "image/png", png(8));
    const second = core.blobs.put(driver, "image/png", png(9));
    const key = "two-players";
    core.devices.register(driver, {
      key,
      name: "Two players",
      type: "media-player",
      capabilities: [
        { kind: "media", id: "main" },
        { kind: "media", id: "aux" },
        { kind: "media", id: "extra" },
      ],
    });
    const playing = (artwork: string) => ({
      activity: "playing",
      media: { artwork },
    });
    const idle = { activity: "idle" };
    core.devices.report(driver, {
      key,
      states: {
        main: playing(first),
        aux: playing(second),
        extra: playing(second),
      },
    });
    await radio.picture("box-1", "image/png", png(9));
    await settled();
    core.advance(2 * blobKeptMs);
    core.blobs.sweep();
    expect(core.blobs.get(first)).not.toBeNull();
    expect(core.blobs.get(second)).not.toBeNull();

    core.devices.report(driver, { key, states: { aux: idle } });
    await radio.press("box-1", { media: null });
    await settled();
    core.advance(blobKeptMs);
    core.blobs.sweep();
    expect(core.blobs.get(second)).not.toBeNull();

    core.devices.report(driver, { key, states: { extra: idle } });
    core.advance(blobKeptMs - 1);
    core.blobs.sweep();
    expect(core.blobs.get(second)).not.toBeNull();
    core.advance(1);
    core.blobs.sweep();
    expect(core.blobs.get(second)).toBeNull();
    expect(core.blobs.get(first)).not.toBeNull();
  });
});

describe("an app's blobs", () => {
  const app = "sanctum.example";
  const otherApp = "sanctum.other";
  const bigPng = (content: number) => {
    const bytes = new Uint8Array(maxBlobBytes);
    bytes.set(png(content));
    return bytes;
  };
  const fit = Math.floor(maxAppBlobBytes / maxBlobBytes);

  it("make room for a new one by letting go of the oldest nothing names", () => {
    let at = 0;
    const blobs = createBlobs({ now: () => new Date(at), log: () => {} });
    const name = namer(blobs, app);
    const hashes = Array.from({ length: fit }, (_, index) => {
      at += 1;
      return blobs.put(app, "image/png", bigPng(index));
    });
    name(hashes[0]!);
    // The oldest is named, so the second oldest goes.
    blobs.put(app, "image/png", bigPng(fit));
    expect(blobs.get(hashes[0]!)).not.toBeNull();
    expect(blobs.get(hashes[1]!)).toBeNull();
  });

  it("keeps existing artwork when an upload cannot make enough room", () => {
    const blobs = createBlobs({ log() {} });
    const name = namer(blobs, app);
    for (let index = 0; index < fit; index += 1) {
      name(blobs.put(app, "image/png", bigPng(index)));
    }
    const unnamed = blobs.put(app, "image/png", png(99));
    expect(() => blobs.put(app, "image/png", bigPng(fit))).toThrow(/16 MB/);
    expect(blobs.get(unnamed)).not.toBeNull();
    expect(() => blobs.put(otherApp, "image/png", bigPng(fit))).not.toThrow();
  });

  it("keep at most 128 of an app's, however small, letting the oldest unnamed go", () => {
    let at = 0;
    const blobs = createBlobs({ now: () => new Date(at), log() {} });
    const name = namer(blobs, app);
    const other = blobs.put(otherApp, "image/png", png(0, 0));
    const hashes = Array.from({ length: maxAppBlobs }, (_, index) => {
      at += 1;
      return blobs.put(app, "image/png", png(index >> 8, index & 0xff, 1));
    });
    name(hashes[0]!);
    blobs.put(app, "image/png", png(255, 255, 1));
    expect(blobs.get(hashes[0]!)).not.toBeNull();
    expect(blobs.get(hashes[1]!)).toBeNull();
    expect(blobs.get(hashes[2]!)).not.toBeNull();
    expect(blobs.get(other)).not.toBeNull();

    for (const hash of hashes) name(hash);
    name(blobs.put(app, "image/png", png(255, 255, 2)));
    expect(() => blobs.put(app, "image/png", png(255, 255, 3))).toThrow(/128/);
  });

  it("retains shared bytes when one owner is removed", () => {
    const blobs = createBlobs({ log() {} });
    const shared = blobs.put(app, "image/png", png(1));
    expect(blobs.put(otherApp, "image/png", png(1))).toBe(shared);
    blobs.removeApp(app);
    expect(blobs.get(shared)).not.toBeNull();
    blobs.removeApp(otherApp);
    expect(blobs.get(shared)).toBeNull();
  });

  it("go when their app is removed, and all go when the core stops", () => {
    const blobs = createBlobs({ log: () => {} });
    const mine = blobs.put(app, "image/png", png(1));
    const other = blobs.put(otherApp, "image/png", png(2));
    blobs.removeApp(app);
    expect(blobs.get(mine)).toBeNull();
    expect(blobs.get(other)).not.toBeNull();
    blobs.close();
    expect(blobs.get(other)).toBeNull();
  });

  it("follow what devices name, from the devices as the core starts", () => {
    let at = 0;
    const blobs = createBlobs({ now: () => new Date(at), log() {} });
    const shown = blobs.put(app, "image/png", png(1));
    const named = blobs.put(app, "image/png", png(2));
    // A device that already names one as the core starts keeps it.
    blobs.start([player(app, shown)]);
    onTestFinished(() => blobs.close());
    at = 2 * blobKeptMs;
    blobs.sweep();
    expect(blobs.get(shown)).not.toBeNull();
    expect(blobs.get(named)).toBeNull();

    // Once it names another, the first has its minute.
    const next = blobs.put(app, "image/png", png(3));
    blobs.deviceChanged({
      id: player(app, null).id,
      before: player(app, shown),
      after: player(app, next),
    });
    at += blobKeptMs - 1;
    blobs.sweep();
    expect(blobs.get(shown)).not.toBeNull();
    at += 1;
    blobs.sweep();
    expect(blobs.get(shown)).toBeNull();
    expect(blobs.get(next)).not.toBeNull();

    // A device removed names nothing.
    blobs.deviceChanged({
      id: player(app, null).id,
      before: player(app, next),
      after: null,
    });
    at += blobKeptMs;
    blobs.sweep();
    expect(blobs.get(next)).toBeNull();
  });

  it("count only the app's own devices' names", () => {
    let at = 0;
    const blobs = createBlobs({ now: () => new Date(at), log() {} });
    const hash = blobs.put(app, "image/png", png(1));
    // Another app's device names the same bytes, which it never put.
    namer(blobs, otherApp)(hash);
    at = blobKeptMs;
    blobs.sweep();
    expect(blobs.get(hash)).toBeNull();
  });

  it("are kept a minute after they are put, for the report that names them", () => {
    let at = 0;
    const blobs = createBlobs({ now: () => new Date(at), log() {} });
    const hash = blobs.put(app, "image/png", png(1));
    at = blobKeptMs - 1;
    blobs.sweep();
    expect(blobs.get(hash)).not.toBeNull();
    namer(blobs, app)(hash);
    at = 10 * blobKeptMs;
    blobs.sweep();
    expect(blobs.get(hash)).not.toBeNull();
  });
});

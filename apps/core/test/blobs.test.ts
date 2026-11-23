import {
  blobKeptMs,
  maxAppBlobBytes,
  maxAppBlobs,
  maxBlobBytes,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { createBlobs } from "../src/blobs/blobs.js";
import { lampsCore, radio, settled } from "./devices-support.js";
import { get, post } from "./support.js";

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
  ]);

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
      /4096 px a side/,
    );
  });

  it("lasts while a device's state names it and 10 minutes after", async () => {
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
    core.advance(minute);
    core.blobs.sweep(); // The first sweep to see that it went unnamed.
    core.advance(blobKeptMs - minute);
    core.blobs.sweep();
    expect(await shown(first)).toBe(200);
    core.advance(2 * minute);
    core.blobs.sweep();
    expect(await shown(first)).toBe(404);
  });

  it("goes with the driver and cannot be restored by its stop hook", async () => {
    const { core, maya } = await pictureCore();
    const bytes = png(7);
    const hash = await radio.picture("box-1", "image/png", bytes);
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
    const named = new Set<string>();
    const blobs = createBlobs({
      named: () => new Map([[app, named]]),
      now: () => new Date(at),
      log: () => {},
    });
    const hashes = Array.from({ length: fit }, (_, index) => {
      at += 1;
      return blobs.put(app, "image/png", bigPng(index));
    });
    named.add(hashes[0]!);
    // The oldest is named, so the second oldest goes.
    blobs.put(app, "image/png", bigPng(fit));
    expect(blobs.get(hashes[0]!)).not.toBeNull();
    expect(blobs.get(hashes[1]!)).toBeNull();
  });

  it("keeps existing artwork when an upload cannot make enough room", () => {
    const named = new Set<string>();
    const blobs = createBlobs({
      named: () => new Map([[app, named]]),
      log() {},
    });
    for (let index = 0; index < fit; index += 1) {
      named.add(blobs.put(app, "image/png", bigPng(index)));
    }
    const unnamed = blobs.put(app, "image/png", png(99));
    expect(() => blobs.put(app, "image/png", bigPng(fit))).toThrow(/16 MB/);
    expect(blobs.get(unnamed)).not.toBeNull();
    expect(() => blobs.put(otherApp, "image/png", bigPng(fit))).not.toThrow();
  });

  it("keep at most 128 of an app's, however small, letting the oldest unnamed go", () => {
    let at = 0;
    const named = new Set<string>();
    const blobs = createBlobs({
      named: () => new Map([[app, named]]),
      now: () => new Date(at),
      log() {},
    });
    const other = blobs.put(otherApp, "image/png", png(0, 0));
    const hashes = Array.from({ length: maxAppBlobs }, (_, index) => {
      at += 1;
      return blobs.put(app, "image/png", png(index >> 8, index & 0xff, 1));
    });
    named.add(hashes[0]!);
    blobs.put(app, "image/png", png(255, 255, 1));
    expect(blobs.get(hashes[0]!)).not.toBeNull();
    expect(blobs.get(hashes[1]!)).toBeNull();
    expect(blobs.get(hashes[2]!)).not.toBeNull();
    expect(blobs.get(other)).not.toBeNull();

    for (const hash of hashes) named.add(hash);
    named.add(blobs.put(app, "image/png", png(255, 255, 2)));
    expect(() => blobs.put(app, "image/png", png(255, 255, 3))).toThrow(/128/);
  });

  it("retains shared bytes when one owner is removed", () => {
    const blobs = createBlobs({ named: () => new Map(), log() {} });
    const shared = blobs.put(app, "image/png", png(1));
    expect(blobs.put(otherApp, "image/png", png(1))).toBe(shared);
    blobs.removeApp(app);
    expect(blobs.get(shared)).not.toBeNull();
    blobs.removeApp(otherApp);
    expect(blobs.get(shared)).toBeNull();
  });

  it("go when their app is removed, and all go when the core stops", () => {
    const blobs = createBlobs({ named: () => new Map(), log: () => {} });
    const mine = blobs.put(app, "image/png", png(1));
    const other = blobs.put(otherApp, "image/png", png(2));
    blobs.removeApp(app);
    expect(blobs.get(mine)).toBeNull();
    expect(blobs.get(other)).not.toBeNull();
    blobs.close();
    expect(blobs.get(other)).toBeNull();
  });
});

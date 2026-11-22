import {
  blobKeptMs,
  maxAppBlobBytes,
  maxBlobBytes,
} from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { createBlobs } from "../src/blobs/blobs.js";
import { lampsCore, radio, settled } from "./devices-support.js";
import { get } from "./support.js";

// Blobs: pictures a driver hands the core, kept in memory by their hash for
// clients to fetch while a device's state names them.

const minute = 60_000;
// Bytes that begin as a PNG does, which is all the core checks of them.
const png = (...rest: number[]) =>
  Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...rest]);

async function pictureCore() {
  const home = await lampsCore();
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
    }
  });

  it("is refused when it isn't a picture of its type, or is too large", async () => {
    await pictureCore();
    await expect(radio.picture("box-1", "image/jpeg", png(1))).rejects.toThrow(
      /cannot keep/,
    );
    const tooLarge = new Uint8Array(maxBlobBytes + 1);
    tooLarge.set(png());
    await expect(radio.picture("box-1", "image/png", tooLarge)).rejects.toThrow(
      /cannot keep/,
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
    core.blobs.sweep();
    core.advance(blobKeptMs - minute);
    core.blobs.sweep();
    expect(await shown(first)).toBe(200);
    core.advance(2 * minute);
    core.blobs.sweep();
    expect(await shown(first)).toBe(404);
  });
});

describe("an app's blobs", () => {
  it("make room for a new one by letting go of the oldest nothing names", () => {
    let at = 0;
    const named = new Set<string>();
    const blobs = createBlobs({
      named: () => named,
      now: () => new Date(at),
      log: () => {},
    });
    const big = (n: number) => {
      const bytes = new Uint8Array(maxBlobBytes);
      bytes.set(png(n));
      return bytes;
    };
    const fit = Math.floor(maxAppBlobBytes / maxBlobBytes);
    const hashes = Array.from({ length: fit }, (_, index) => {
      at += 1;
      return blobs.put("sanctum.example", "image/png", big(index));
    });
    named.add(hashes[0]!);
    // The oldest is named, so the second oldest goes.
    blobs.put("sanctum.example", "image/png", big(fit));
    expect(blobs.get(hashes[0]!)).not.toBeNull();
    expect(blobs.get(hashes[1]!)).toBeNull();
    // Another app's are its own.
    expect(blobs.put("sanctum.other", "image/png", big(0))).toBe(hashes[0]);

    for (const hash of hashes) named.add(hash);
    named.add(blobs.put("sanctum.example", "image/png", big(fit + 1)));
    expect(() =>
      blobs.put("sanctum.example", "image/png", big(fit + 2)),
    ).toThrow(/16 MB/);
  });

  it("go when their app is removed, and all go when the core stops", () => {
    const blobs = createBlobs({ named: () => new Set(), log: () => {} });
    const mine = blobs.put("sanctum.example", "image/png", png(1));
    const other = blobs.put("sanctum.other", "image/png", png(2));
    blobs.removeApp("sanctum.example");
    expect(blobs.get(mine)).toBeNull();
    expect(blobs.get(other)).not.toBeNull();
    blobs.close();
    expect(blobs.get(other)).toBeNull();
  });
});

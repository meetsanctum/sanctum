import { expect, it, vi } from "vitest";

import { Unreachable, type Pairing } from "../src/boxes.js";
import { createPairings } from "../src/pairing.js";
import { createSightings } from "../src/sightings.js";
import { createFakeBoxes, FakeBox } from "./fake-boxes.js";

function setup() {
  const box = new FakeBox({ deviceId: "6E:D2:21:38:B4:95", name: "TV" });
  const sightings = createSightings();
  sightings.take({ found: box.sightings(), lost: [] });
  const endpoint = sightings.boxes().get(box.key);
  if (endpoint?.kind !== "tv") throw new Error("No TV endpoint");
  const { boxes } = createFakeBoxes(box);
  const pairings = createPairings(boxes, { retryMs: 5 });
  const done = vi.fn(async () => {});
  const step = (answers: Record<string, string> = {}) =>
    pairings.step(box.key, endpoint, { attempt: "first", answers }, done);
  return { box, boxes, pairings, step };
}

it("cancels a pending Companion retry on shutdown", async () => {
  const { box, boxes, pairings, step } = setup();
  await step();
  const failed = Promise.reject(new Unreachable("Companion refused to open"));
  const pair = vi.spyOn(boxes, "pairCompanion").mockReturnValueOnce(failed);
  const pending = step({ airplayCode: box.code("airplay") });
  await failed.catch(() => {});

  pairings.closeAll();
  await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  expect(pair).toHaveBeenCalledOnce();
  expect(box.open).toBe(0);
  expect(box.showing.size).toBe(0);
});

it.each(["airplay", "companion"] as const)(
  "closes a %s pairing that finishes opening after shutdown",
  async (protocol) => {
    const { box, boxes, pairings, step } = setup();
    let resolve!: (pairing: Pairing) => void;
    const opening = new Promise<Pairing>((done) => {
      resolve = done;
    });
    const method = protocol === "airplay" ? "pairAirPlay" : "pairCompanion";
    const pair = vi.spyOn(boxes, method).mockReturnValueOnce(opening);
    if (protocol === "companion") await step();
    const pending =
      protocol === "airplay"
        ? step()
        : step({ airplayCode: box.code("airplay") });
    await Promise.resolve();
    expect(pair).toHaveBeenCalledOnce();

    pairings.closeAll();
    resolve(box.pair(protocol));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(pairings.isOpen(box.key)).toBe(false);
    expect(box.open).toBe(0);
    expect(box.showing.size).toBe(0);
  },
);

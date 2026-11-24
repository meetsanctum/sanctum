import { expect, it, vi } from "vitest";

import { PairingLost, type Player } from "../src/boxes.js";
import { createPlayerLink } from "../src/player-link.js";
import { createSightings } from "../src/sightings.js";
import { createFakeBoxes, FakeBox } from "./fake-boxes.js";

it("keeps the verified player until a new address connects", async () => {
  const box = new FakeBox({ deviceId: "6E:D2:21:38:B4:95", name: "TV" });
  const sightings = createSightings();
  sightings.take({ found: box.sightings(), lost: [] });
  const endpoint = sightings.boxes().get(box.key);
  if (endpoint?.kind !== "tv") throw new Error("No TV endpoint");
  const keys = await box.pair("airplay").finish(box.code("airplay"));
  const { boxes } = createFakeBoxes(box);
  const news = {
    changed: vi.fn(),
    slept: vi.fn(),
    lost: vi.fn(),
    log: vi.fn(),
  };
  const link = createPlayerLink({ key: box.key, boxes, news });
  const rejected = { ...endpoint, address: "192.168.1.50" };
  const replacement = { ...endpoint, address: "192.168.1.51" };
  const play = boxes.play;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  const dial = vi
    .spyOn(boxes, "play")
    .mockImplementation(async (at, withKeys) => {
      if (at === rejected) throw new PairingLost("Pairing was rejected");
      if (at === replacement) await pending;
      return play(at, withKeys);
    });

  try {
    link.start(keys, endpoint);
    await vi.waitFor(() => expect(link.player).not.toBeNull());
    const original = link.player;
    link.seen(rejected);
    await vi.waitFor(() => expect(news.log).toHaveBeenCalledOnce());
    expect(link.player).toBe(original);
    expect(news.lost).not.toHaveBeenCalled();

    box.endSessions();
    await vi.waitFor(() => expect(link.player).not.toBeNull());
    expect(dial).toHaveBeenLastCalledWith(endpoint, keys);
    const reconnected = link.player as Player;

    link.seen(replacement);
    expect(dial).toHaveBeenLastCalledWith(replacement, keys);
    expect(link.player).toBe(reconnected);
    release();
    await vi.waitFor(() => expect(link.player).not.toBe(reconnected));
    expect(box.players).toEqual([link.player]);
  } finally {
    release();
    link.stop();
  }
});

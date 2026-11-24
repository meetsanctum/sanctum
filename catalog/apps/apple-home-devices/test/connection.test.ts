import { expect, it, vi } from "vitest";

import { PairingLost, type Link } from "../src/boxes.js";
import { createConnection } from "../src/connection.js";
import { createSightings } from "../src/sightings.js";
import { createFakeBoxes, FakeBox } from "./fake-boxes.js";

async function remote() {
  const box = new FakeBox({ deviceId: "6E:D2:21:38:B4:95", name: "TV" });
  const sightings = createSightings();
  sightings.take({ found: box.sightings(), lost: [] });
  const endpoint = sightings.boxes().get(box.key);
  if (endpoint?.kind !== "tv") throw new Error("No TV endpoint");
  const keys = await box.pair("companion").finish(box.code("companion"));
  const { boxes } = createFakeBoxes(box);
  const news = {
    online: vi.fn(),
    state: vi.fn(),
    lost: vi.fn(),
    log: vi.fn(),
  };
  const connection = createConnection({
    key: box.key,
    boxes,
    news,
    timings: { firstRetryMs: 20 },
    random: () => 0.5,
  });
  return { box, boxes, connection, endpoint, keys, news };
}

it("keeps the verified link and retries its address if a new one rejects the pairing", async () => {
  const { box, boxes, connection, endpoint, keys, news } = await remote();
  const candidate = { ...endpoint, companionAddress: "192.168.1.50" };
  const connect = boxes.connect;
  const dial = vi
    .spyOn(boxes, "connect")
    .mockImplementation((at, withKeys) =>
      at.companionAddress === candidate.companionAddress
        ? Promise.reject(new PairingLost("Pairing was rejected"))
        : connect(at, withKeys),
    );

  try {
    connection.seen(endpoint);
    connection.start(keys);
    await vi.waitFor(() => expect(connection.connected).toBe(true));
    const original = box.links[0];
    connection.seen(candidate);
    await vi.waitFor(() => expect(news.log).toHaveBeenCalledOnce());
    expect(box.links).toEqual([original]);
    await connection.volume("up");

    box.dropAll();
    await vi.waitFor(() => expect(connection.connected).toBe(true));
    expect(dial).toHaveBeenLastCalledWith(endpoint, keys);
    expect(news.lost).not.toHaveBeenCalled();
  } finally {
    connection.stop();
  }
});

it("discards a pending link when the TV is seen at a newer address", async () => {
  const { box, boxes, connection, endpoint, keys, news } = await remote();
  const moved = { ...endpoint, companionAddress: "192.168.1.50" };
  let resolve!: (link: Link) => void;
  const pending = new Promise<Link>((done) => {
    resolve = done;
  });
  const dial = vi.spyOn(boxes, "connect").mockReturnValueOnce(pending);
  const original = await createFakeBoxes(box).boxes.connect(endpoint, keys);
  const close = vi.spyOn(original, "close");
  try {
    connection.seen(endpoint);
    connection.start(keys);
    connection.seen(moved);
    resolve(original);

    await vi.waitFor(() => expect(connection.connected).toBe(true));
    expect(close).toHaveBeenCalledOnce();
    expect(dial).toHaveBeenLastCalledWith(moved, keys);
    expect(news.online).toHaveBeenCalledExactlyOnceWith(true);
  } finally {
    connection.stop();
  }
});

it("ignores a pending rejection for superseded pairing keys", async () => {
  const { box, boxes, connection, endpoint, keys, news } = await remote();
  const replacement = await box.pair("companion").finish(box.code("companion"));
  let reject!: (error: Error) => void;
  const pending = new Promise<Link>((_, fail) => {
    reject = fail;
  });
  const dial = vi.spyOn(boxes, "connect").mockReturnValueOnce(pending);
  try {
    connection.seen(endpoint);
    connection.start(keys);
    connection.rekey(replacement, endpoint);
    reject(new PairingLost("Previous pairing was rejected"));

    await vi.waitFor(() => expect(connection.connected).toBe(true));
    expect(dial).toHaveBeenLastCalledWith(endpoint, replacement);
    expect(news.lost).not.toHaveBeenCalled();
  } finally {
    connection.stop();
  }
});

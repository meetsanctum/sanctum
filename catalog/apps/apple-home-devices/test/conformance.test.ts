import { describeDriver } from "@meetsanctum/app-testkit";

import { createAppleHomeDevicesApp } from "../src/index.js";
import { createFakeBoxes, FakeBox } from "./fake-boxes.js";

// The capability test suite, with each Apple TV played by a fake box, found
// on the network and added with both of its codes.

const fake = createFakeBoxes();
const boxes = new Map<string, FakeBox>();
let made = 0;

describeDriver({
  app: createAppleHomeDevicesApp({
    boxes: fake.boxes,
    timings: { offlineMs: 60, firstRetryMs: 20, lastRetryMs: 80 },
  }),
  kinds: ["media"],
  async add(_kind, core) {
    made += 1;
    const box = new FakeBox({
      deviceId: `AA:BB:CC:00:00:${made.toString(16).padStart(2, "0").toUpperCase()}`,
      name: `Room ${made}`,
    });
    fake.add(box);
    boxes.set(box.key, box);
    await core.discovered({ found: box.sightings(), lost: [] });
    const attempt = await core.startAdd(box.key);
    await attempt.answer({ airplayCode: box.code("airplay") });
    await attempt.answer({ companionCode: box.code("companion") });
    await core.until(() => box.links.length === 1, `${box.name} connected`);
    await core.until(
      () => core.latest(box.key, "media") !== undefined,
      `${box.name} said its state`,
    );
    return box.key;
  },
  async unplug(key) {
    const box = boxes.get(key)!;
    box.reachable = false;
    box.dropAll();
  },
});

import type { AppContext, MediaState } from "@meetsanctum/app-sdk";
import { createDriverCore, type DriverCore } from "@meetsanctum/app-testkit";
import { afterEach, expect } from "vitest";

import { createAppleHomeDevicesApp } from "../src/index.js";
import { createFakeBoxes, FakeBox } from "./fake-boxes.js";

// Homes for the tests: a test core running the app against fake Apple TVs,
// each stopped once its test ends.

export const timings = {
  offlineMs: 60,
  firstRetryMs: 20,
  lastRetryMs: 80,
  wakeTriesMs: 100,
  wakeRetryMs: 10,
  wakeMs: 100,
  sleepMs: 50,
  wakeOpenMs: 5,
  holdMs: 100,
  settleMs: 100,
  pictureWaitMs: 50,
  gatherMs: 5,
};

export type Home = {
  core: DriverCore;
  boxes: FakeBox[];
};

/** The homes made in a test, stopped after it. */
export const homes: Home[] = [];

afterEach(async () => {
  for (const home of homes.splice(0)) await home.core.stop();
});

export function livingRoom() {
  return new FakeBox({ deviceId: "6E:D2:21:38:B4:95", name: "Living Room" });
}

export function gym() {
  return new FakeBox({
    deviceId: "EE:18:90:EF:56:78",
    name: "Gym",
    model: "AppleTV6,2",
    address: "192.168.1.41",
  });
}

export async function home(...boxes: FakeBox[]): Promise<Home> {
  return homeWith(boxes);
}

export async function homeWith(
  boxes: FakeBox[],
  onStart?: (ctx: AppContext) => void,
): Promise<Home> {
  const fake = createFakeBoxes(...boxes);
  const app = createAppleHomeDevicesApp({
    boxes: fake.boxes,
    timings,
    random: () => 0.5,
    pairing: { retryMs: 5 },
  });
  const core = createDriverCore({
    ...app,
    async start(ctx, info) {
      onStart?.(ctx);
      await app.start!(ctx, info);
    },
  });
  await core.start();
  await core.discovered({
    found: boxes.flatMap((box) => box.sightings()),
    lost: [],
  });
  const made = { core, boxes };
  homes.push(made);
  return made;
}

/** Adds a box with both of its codes, as someone reading them off the TV. */
export async function added(core: DriverCore, box: FakeBox) {
  const attempt = await core.startAdd(box.key);
  await attempt.answer({ airplayCode: box.code("airplay") });
  const state = await attempt.answer({ companionCode: box.code("companion") });
  expect(state.kind).toBe("done");
  await core.until(() => box.links.length === 1, "connected");
}

/** What the core last heard of a box's media state. */
export function stateOf(core: DriverCore, box: FakeBox) {
  return core.latest(box.key, "media") as MediaState | undefined;
}

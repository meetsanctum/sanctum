import { createDriverCore, type DriverCore } from "@meetsanctum/app-testkit";
import { afterEach, describe, expect, it } from "vitest";

import { createAppleHomeDevicesApp } from "../src/index.js";
import { createFakeBoxes, FakeBox } from "./fake-boxes.js";

// Apple TVs found, added with both of their codes, kept connected, turned
// on and off and stepped up and down, and paired again once they forget
// Sanctum, against fake boxes standing in for the network.

const timings = { offlineMs: 60, firstRetryMs: 20, lastRetryMs: 80 };

type Home = {
  core: DriverCore;
  boxes: FakeBox[];
};

let homes: Home[] = [];

afterEach(async () => {
  for (const home of homes) await home.core.stop();
  homes = [];
});

function livingRoom() {
  return new FakeBox({ deviceId: "6E:D2:21:38:B4:95", name: "Living Room" });
}

function gym() {
  return new FakeBox({
    deviceId: "EE:18:90:EF:56:78",
    name: "Gym",
    model: "AppleTV6,2",
    address: "192.168.1.41",
  });
}

async function home(...boxes: FakeBox[]): Promise<Home> {
  const fake = createFakeBoxes(...boxes);
  const core = createDriverCore(
    createAppleHomeDevicesApp({
      boxes: fake.boxes,
      timings,
      random: () => 0.5,
      pairing: { retryMs: 5 },
    }),
  );
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
async function added(core: DriverCore, box: FakeBox) {
  const attempt = await core.startAdd(box.key);
  await attempt.answer({ airplayCode: box.code("airplay") });
  const state = await attempt.answer({ companionCode: box.code("companion") });
  expect(state.kind).toBe("done");
  await core.until(() => box.links.length === 1, "connected");
}

describe("finding", () => {
  it("lists Apple TVs and HomePods by their name and model, not Macs", async () => {
    const mac = new FakeBox({
      deviceId: "11:22:33:44:55:66",
      name: "Studio",
      model: "Mac16,10",
    });
    const kitchen = new FakeBox({
      deviceId: "22:33:44:55:66:77",
      name: "Kitchen",
      model: "AudioAccessory5,1",
    });
    const { core } = await home(livingRoom(), gym(), mac, kitchen);
    expect(
      core.found.map(({ name, description, type, asks }) => ({
        name,
        description,
        type,
        asks: asks.map((each) => each.id),
      })),
    ).toEqual([
      {
        name: "Living Room",
        description: "Apple TV 4K (3rd generation)",
        type: "media-player",
        asks: [],
      },
      {
        name: "Gym",
        description: "Apple TV 4K",
        type: "media-player",
        asks: [],
      },
      {
        name: "Kitchen",
        description: "HomePod mini",
        type: "media-player",
        asks: [],
      },
    ]);
  });

  it("lists an Apple TV only once it announces Companion too", async () => {
    const box = livingRoom();
    const fake = createFakeBoxes(box);
    const core = createDriverCore(
      createAppleHomeDevicesApp({ boxes: fake.boxes, timings }),
    );
    homes.push({ core, boxes: [box] });
    await core.start();
    const [airplay, companion] = box.sightings();
    await core.discovered({ found: [airplay!], lost: [] });
    expect(core.found).toEqual([]);
    await core.discovered({ found: [companion!], lost: [] });
    expect(core.found.map((each) => each.key)).toEqual([box.key]);
  });
});

describe("adding", () => {
  it("asks AirPlay's code, then Companion's, and adds the TV once both pass", async () => {
    const box = livingRoom();
    const { core } = await home(box);
    const attempt = await core.startAdd(box.key);
    expect(attempt.asks.map((each) => each.id)).toEqual(["airplayCode"]);
    expect(box.showing.has("airplay")).toBe(true);

    await attempt.answer({ airplayCode: box.code("airplay") });
    expect(attempt.asks.map((each) => each.id)).toEqual(["companionCode"]);
    expect(attempt.asks[0]!.lasts).toEqual({
      seconds: 35,
      again: "Show a new code",
    });
    // Nothing is kept until the second code passes.
    expect(core.secrets.size).toBe(0);
    expect(core.registered.size).toBe(0);

    const state = await attempt.answer({
      companionCode: box.code("companion"),
    });
    expect(state.kind).toBe("done");
    // Its volume steps come once the TV says it takes them.
    await core.until(
      () =>
        (
          core.registered.get(box.key)?.capabilities[0]?.features as
            { volume?: unknown } | undefined
        )?.volume === "steps",
      "registered with volume steps",
    );
    expect(core.registered.get(box.key)).toMatchObject({
      name: "Living Room",
      manufacturer: "Apple",
      model: "Apple TV 4K (3rd generation)",
      type: "media-player",
      capabilities: [
        {
          id: "media",
          kind: "media",
          features: { power: true, playback: [], volume: "steps", mute: false },
        },
      ],
    });
    const kept = JSON.parse(core.secrets.get(`box:${box.key}`)!);
    expect(Object.keys(kept)).toEqual(["airplay", "companion"]);
    expect(box.open).toBe(0);
    await core.until(
      () => core.availability.get(box.key) === "online",
      "online",
    );
    await core.until(
      () => core.latest(box.key, "media")?.on === true,
      "its power said",
    );
    expect(core.latest(box.key, "media")).toEqual({
      on: true,
      activity: "idle",
    });
    expect(core.found).toEqual([]);
  });

  it("ends after a wrong first code, and Add gets a new one that works", async () => {
    const box = livingRoom();
    const { core } = await home(box);
    const attempt = await core.startAdd(box.key);
    const first = box.code("airplay");
    const state = await attempt.answer({ airplayCode: box.wrong("airplay") });
    expect(state).toEqual({
      kind: "refused",
      question: "airplayCode",
      refusal: "wrongCode",
    });
    // Every pairing is closed, so the TV takes the old code off the screen.
    expect(box.open).toBe(0);
    expect(box.showing.has("airplay")).toBe(false);
    expect(core.secrets.size).toBe(0);

    const again = await core.startAdd(box.key);
    expect(box.code("airplay")).not.toBe(first);
    await again.answer({ airplayCode: box.code("airplay") });
    expect(again.asks.map((each) => each.id)).toEqual(["companionCode"]);
  });

  it("shows a new second code when asked, and after a wrong or late one", async () => {
    const box = livingRoom();
    const { core } = await home(box);
    const attempt = await core.startAdd(box.key);
    await attempt.answer({ airplayCode: box.code("airplay") });

    const first = box.code("companion");
    await attempt.again("companionCode");
    expect(box.code("companion")).not.toBe(first);
    expect(box.open).toBe(1);

    let state = await attempt.answer({ companionCode: box.wrong("companion") });
    expect(state).toMatchObject({
      kind: "asking",
      refused: { question: "companionCode", refusal: "wrongCode" },
    });

    // The TV took the code away as it was typed.
    const late = box.code("companion");
    box.expire();
    state = await attempt.answer({ companionCode: late });
    expect(state).toMatchObject({
      kind: "asking",
      refused: { question: "companionCode", refusal: "expired" },
    });

    state = await attempt.answer({ companionCode: box.code("companion") });
    expect(state.kind).toBe("done");
    expect(box.open).toBe(0);
  });

  it("closes the pairing and keeps nothing when it's cancelled after the first code", async () => {
    const box = livingRoom();
    const { core } = await home(box);
    const attempt = await core.startAdd(box.key);
    await attempt.answer({ airplayCode: box.code("airplay") });
    expect(box.open).toBe(1);
    await attempt.cancel();
    expect(box.open).toBe(0);
    expect(box.showing.size).toBe(0);
    expect(core.secrets.size).toBe(0);
    expect(core.registered.size).toBe(0);

    // Adding again starts afresh, from the first code.
    await added(core, box);
    expect(core.registered.has(box.key)).toBe(true);
  });

  it("drops what an earlier attempt left open when a new one starts", async () => {
    const box = livingRoom();
    const { core } = await home(box);
    const earlier = await core.startAdd(box.key);
    await earlier.answer({ airplayCode: box.code("airplay") });
    expect(box.showing.has("companion")).toBe(true);

    const later = await core.startAdd(box.key);
    expect(later.asks.map((each) => each.id)).toEqual(["airplayCode"]);
    expect(box.open).toBe(1);
    expect(box.showing.has("companion")).toBe(false);
  });

  it("closes every open pairing as it stops", async () => {
    const box = livingRoom();
    const { core } = await home(box);
    await core.startAdd(box.key);
    expect(box.open).toBe(1);
    await core.stop();
    expect(box.open).toBe(0);
  });

  it("ends the time a code lasts with the attempt, closing its pairing", async () => {
    const box = livingRoom();
    const { core } = await home(box);
    const attempt = await core.startAdd(box.key);
    await attempt.answer({ airplayCode: box.code("airplay") });
    const state = await attempt.elapse(180_000);
    expect(state).toEqual({ kind: "ended", why: "time" });
    expect(box.open).toBe(0);
  });

  it("refuses a HomePod, which shows no code, at once", async () => {
    const kitchen = new FakeBox({
      deviceId: "22:33:44:55:66:77",
      name: "Kitchen",
      model: "AudioAccessory5,1",
    });
    const { core } = await home(kitchen);
    const attempt = await core.startAdd(kitchen.key);
    expect(attempt.state).toEqual({ kind: "refused", refusal: "homePod" });
    expect(kitchen.open).toBe(0);
  });

  it("refuses a TV that allows no pairing, and one it can't reach", async () => {
    const box = livingRoom();
    const { core } = await home(box);
    box.allowsPairing = false;
    expect((await core.startAdd(box.key)).state).toEqual({
      kind: "refused",
      refusal: "notAllowed",
    });
    box.allowsPairing = true;
    box.reachable = false;
    expect((await core.startAdd(box.key)).state).toEqual({
      kind: "refused",
      refusal: "unreachable",
    });
  });
});

describe("connected", () => {
  it("turns the TV on and off and steps its volume", async () => {
    const box = livingRoom();
    const { core } = await home(box);
    await added(core, box);
    await core.command(box.key, "media", "media", { on: false });
    await core.until(() => core.latest(box.key, "media")?.on === false, "off");
    await core.command(box.key, "media", "media", { volumeStep: "up" });
    await core.command(box.key, "media", "media", { volumeStep: "down" });
    await core.command(box.key, "media", "media", { on: true });
    expect(box.pressed).toEqual(["sleep", "up", "down", "wake"]);
  });

  it("follows the TV turned on and off by its own remote", async () => {
    const box = livingRoom();
    const { core } = await home(box);
    await added(core, box);
    box.setPower(false);
    await core.until(() => core.latest(box.key, "media")?.on === false, "off");
    box.setPower(true);
    await core.until(() => core.latest(box.key, "media")?.on === true, "on");
  });

  it("takes a TV that doesn't tell its power to be what it was last turned to", async () => {
    const box = gym();
    box.tellsPower = false;
    const { core } = await home(box);
    await added(core, box);
    await core.until(
      () => core.latest(box.key, "media") !== undefined,
      "its state said",
    );
    expect(core.latest(box.key, "media")).toEqual({ activity: "idle" });
    await core.command(box.key, "media", "media", { on: true });
    expect(core.latest(box.key, "media")).toEqual({
      on: true,
      activity: "idle",
    });
    await core.command(box.key, "media", "media", { on: false });
    expect(core.latest(box.key, "media")).toEqual({
      on: false,
      activity: "idle",
    });
  });

  it("keeps the TV's volume while it's off, when it offers none", async () => {
    const box = livingRoom();
    const { core } = await home(box);
    await added(core, box);
    const volume = () =>
      (
        core.registered.get(box.key)!.capabilities[0]!.features as {
          volume: unknown;
        }
      ).volume;
    await core.until(() => volume() === "steps", "registered with steps");
    const registered = core.registered.get(box.key);
    box.on = false;
    box.setVolume("unavailable");
    await core.until(() => core.latest(box.key, "media")?.on === false, "off");
    expect(volume()).toBe("steps");
    expect(core.registered.get(box.key)).toBe(registered);
  });

  it("registers no volume for a TV that never says it takes steps", async () => {
    const box = gym();
    box.volume = "unknown";
    const { core } = await home(box);
    await added(core, box);
    await core.until(() => core.latest(box.key, "media") !== undefined, "said");
    expect(
      (
        core.registered.get(box.key)!.capabilities[0]!.features as {
          volume: unknown;
        }
      ).volume,
    ).toBeNull();
  });

  it("registers the TV again without volume where it says it has none", async () => {
    const box = gym();
    box.volume = "unavailable";
    const { core } = await home(box);
    await added(core, box);
    const volume = () =>
      (
        core.registered.get(box.key)!.capabilities[0]!.features as {
          volume: unknown;
        }
      ).volume;
    await core.until(() => volume() === null, "registered without volume");
    box.setVolume("available");
    await core.until(() => volume() === "steps", "registered with steps");
  });

  it("goes offline after a drop and comes back by itself", async () => {
    const box = livingRoom();
    const { core } = await home(box);
    await added(core, box);
    box.reachable = false;
    box.dropAll();
    await core.until(
      () => core.availability.get(box.key) === "offline",
      "offline",
    );
    const tries = box.connects;
    await core.until(() => box.connects > tries + 1, "tried again");
    box.reachable = true;
    await core.until(() => core.availability.get(box.key) === "online", "back");
    expect(box.links).toHaveLength(1);
  });

  it("connects again at once to a TV seen at a new address", async () => {
    const box = livingRoom();
    const { core } = await home(box);
    await added(core, box);
    const tries = box.connects;
    const [airplay, companion] = box.sightings();
    await core.discovered({
      found: [
        { ...airplay!, addresses: ["192.168.1.50"] },
        { ...companion!, addresses: ["192.168.1.50"] },
      ],
      lost: [],
    });
    await core.until(() => box.connects === tries + 1, "connected anew");
    await core.until(() => box.links.length === 1, "one connection");
  });

  it("connects the TVs it has as it starts, and says one without its keys lost them", async () => {
    const box = livingRoom();
    const first = await home(box);
    await added(first.core, box);
    await first.core.stop();
    expect(box.links).toHaveLength(0);
    await first.core.start();
    await first.core.discovered({ found: box.sightings(), lost: [] });
    await first.core.until(() => box.links.length === 1, "connected again");

    first.core.secrets.clear();
    await first.core.stop();
    await first.core.start();
    expect(first.core.problems.get(box.key)?.id).toBe("pairingLost");
  });
});

describe("a lost pairing", () => {
  it("says so, stops trying, and pairs again with both codes on Repair", async () => {
    const box = livingRoom();
    const { core } = await home(box);
    await added(core, box);
    const kept = core.secrets.get(`box:${box.key}`);
    box.forget();
    await core.until(
      () => core.problems.get(box.key)?.id === "pairingLost",
      "lost",
    );
    const tries = box.connects;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(box.connects).toBe(tries);

    const repair = await core.startRepair(box.key);
    expect(repair.asks.map((each) => each.id)).toEqual(["airplayCode"]);
    await repair.answer({ airplayCode: box.code("airplay") });
    // The old keys stay until both new codes pass.
    expect(core.secrets.get(`box:${box.key}`)).toBe(kept);
    const state = await repair.answer({ companionCode: box.code("companion") });
    expect(state.kind).toBe("done");
    expect(core.problems.has(box.key)).toBe(false);
    expect(core.secrets.get(`box:${box.key}`)).not.toBe(kept);
    await core.until(() => box.links.length === 1, "connected again");
  });

  it("keeps the old keys when Repair is cancelled", async () => {
    const box = livingRoom();
    const { core } = await home(box);
    await added(core, box);
    const kept = core.secrets.get(`box:${box.key}`);
    box.forget();
    await core.until(() => core.problems.has(box.key), "lost");
    const repair = await core.startRepair(box.key);
    await repair.answer({ airplayCode: box.code("airplay") });
    await repair.cancel();
    expect(box.open).toBe(0);
    expect(core.secrets.get(`box:${box.key}`)).toBe(kept);
  });
});

describe("removing", () => {
  it("drops the TV's connection and keys, and lists it again", async () => {
    const box = livingRoom();
    const { core } = await home(box);
    await added(core, box);
    await core.remove(box.key);
    expect(box.links).toHaveLength(0);
    expect(core.secrets.size).toBe(0);
    expect(core.found.map((each) => each.key)).toEqual([box.key]);
  });
});

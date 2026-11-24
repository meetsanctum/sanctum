import { ActionError } from "@meetsanctum/app-sdk";
import { createDriverCore } from "@meetsanctum/app-testkit";
import { describe, expect, it, vi } from "vitest";

import { createAppleHomeDevicesApp } from "../src/index.js";
import { createSightings } from "../src/sightings.js";
import { createFakeBoxes, FakeBox } from "./fake-boxes.js";
import {
  added,
  gym,
  home,
  homes,
  homeWith,
  livingRoom,
  stateOf,
  timings,
} from "./homes.js";

// Apple TVs found, added with both of their codes, kept connected, turned
// on and off and stepped up and down, and paired again once they forget
// Sanctum, against fake boxes standing in for the network.

describe("finding", () => {
  it("keeps valid TVs listed when another service has a blank name", async () => {
    const box = livingRoom();
    const blank = new FakeBox({
      deviceId: "11:22:33:44:55:66",
      name: "  ",
    });
    const { core } = await home(box, blank);
    expect(core.found.map((each) => each.key)).toEqual([box.key]);
  });

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

  it("keeps a matched Companion endpoint briefly after it disappears", () => {
    const sightings = createSightings();
    const announced = livingRoom();
    const unmatched = gym();
    const [airplay, companion] = announced.sightings();
    const [otherAirplay, otherCompanion] = unmatched.sightings();
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    try {
      sightings.take({
        found: [airplay!, companion!, otherCompanion!],
        lost: [],
      });
      sightings.take({
        found: [],
        lost: [companion!, otherCompanion!],
      });
      sightings.take({ found: [otherAirplay!], lost: [] });
      expect([...sightings.boxes().keys()]).toEqual([announced.key]);
      now.mockReturnValue(5 * 60_000);
      expect(sightings.boxes().size).toBe(0);
    } finally {
      now.mockRestore();
    }
  });
});

describe("adding", () => {
  it("can add the same TV after registration is refused", async () => {
    const box = livingRoom();
    const { core } = await homeWith([box], (ctx) => {
      vi.spyOn(ctx.devices, "register").mockRejectedValueOnce(
        new ActionError("forbidden", "Registration refused"),
      );
    });
    const first = await core.startAdd(box.key);
    await first.answer({ airplayCode: box.code("airplay") });
    await expect(
      first.answer({ companionCode: box.code("companion") }),
    ).rejects.toThrow("Registration refused");
    expect(core.registered.has(box.key)).toBe(false);
    expect(core.secrets.size).toBe(0);
    expect(core.found.map((each) => each.key)).toEqual([box.key]);

    await added(core, box);
    expect(core.registered.has(box.key)).toBe(true);
  });

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
          features: {
            power: true,
            playback: ["play", "pause", "stop", "next", "previous", "seek"],
            volume: "steps",
            mute: false,
          },
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
      app: null,
      media: null,
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

  it("reports power in order while a volume registration is pending", async () => {
    const box = livingRoom();
    box.on = false;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    let finishRegistration!: () => void;
    const finish = new Promise<void>((resolve) => {
      finishRegistration = resolve;
    });
    const { core } = await homeWith([box], (ctx) => {
      const register = ctx.devices.register;
      vi.spyOn(ctx.devices, "register").mockImplementation(async (input) => {
        const media = input.capabilities[0];
        if (media?.kind === "media" && media.features?.volume === "steps") {
          markStarted();
          await finish;
        }
        return register(input);
      });
    });
    await added(core, box);
    await core.until(() => core.latest(box.key, "media")?.on === false, "off");
    const before = core.reports.length;
    box.setPower(true);
    try {
      await started;
      box.setPower(false);
    } finally {
      finishRegistration();
    }
    const updates = () =>
      core.reports
        .slice(before)
        .flatMap(({ states }) => (states.media ? [states.media.on] : []));
    // Changes that come while a registration is pending are passed on
    // together: the last word, and never an older one after it.
    await core.until(() => updates().at(-1) === false, "off again");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(updates().at(-1)).toBe(false);
  });

  it("takes a TV that doesn't tell its power to be what it was last turned to", async () => {
    const box = gym();
    box.tellsPower = false;
    // Without its player, nothing but Companion says anything.
    box.playerReachable = false;
    const { core } = await home(box);
    await added(core, box);
    await core.until(
      () => core.latest(box.key, "media") !== undefined,
      "its state said",
    );
    const nothing = { activity: "idle", app: null, media: null };
    expect(core.latest(box.key, "media")).toEqual(nothing);
    await core.command(box.key, "media", "media", { on: true });
    await core.until(() => core.latest(box.key, "media")?.on === true, "on");
    expect(core.latest(box.key, "media")).toEqual({ on: true, ...nothing });
    await core.command(box.key, "media", "media", { on: false });
    await core.until(() => core.latest(box.key, "media")?.on === false, "off");
    expect(core.latest(box.key, "media")).toEqual({ on: false, ...nothing });
  });

  it("takes the player's word on power where Companion says nothing of it", async () => {
    const box = gym();
    box.tellsPower = false;
    const { core } = await home(box);
    await added(core, box);
    await core.until(() => core.latest(box.key, "media")?.on === true, "on");
    box.setPower(false);
    await core.until(() => core.latest(box.key, "media")?.on === false, "off");
    expect(box.players).toHaveLength(0);
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
    const { core } = await home(box);
    await added(core, box);
    const volume = () =>
      (
        core.registered.get(box.key)!.capabilities[0]!.features as {
          volume: unknown;
        }
      ).volume;
    await core.until(() => volume() === "steps", "registered with steps");
    box.setVolume("unknown");
    // Something else it says, to see the unknown volume passed over.
    box.play({ title: "Weather" });
    await core.until(
      () => stateOf(core, box)?.media?.title === "Weather",
      "said with unknown volume",
    );
    expect(volume()).toBe("steps");
    box.setVolume("unavailable");
    await core.until(() => volume() === null, "registered without volume");
    box.setVolume("available");
    await core.until(() => volume() === "steps", "registered with steps");
  });

  it("clears unavailable volume steps saved before a restart", async () => {
    const box = livingRoom();
    const { core } = await home(box);
    const volume = () => {
      const capability = core.devices()[0]?.capabilities[0];
      return capability?.kind === "media"
        ? capability.features.volume
        : undefined;
    };
    await added(core, box);
    await core.until(() => volume() === "steps", "saved steps");
    await core.stop();
    box.volume = "unavailable";
    await core.start();
    await core.discovered({ found: box.sightings(), lost: [] });
    await core.until(() => volume() === null, "saved volume cleared");
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
    expect(box.endpoints.at(-1)?.companionAddress).toBe("192.168.1.50");
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

  it("connects other TVs when a startup pairing problem cannot be reported", async () => {
    const missing = livingRoom();
    const kept = gym();
    const { core } = await homeWith([missing, kept], (ctx) => {
      vi.spyOn(ctx.devices, "problem").mockRejectedValueOnce(
        new ActionError("not_found", "The device no longer exists"),
      );
    });
    await added(core, missing);
    await added(core, kept);
    await core.stop();
    core.secrets.delete(`box:${missing.key}`);

    await core.start();
    await core.discovered({ found: kept.sightings(), lost: [] });
    await core.until(() => kept.links.length === 1, "connected again");
  });
});

describe("a lost pairing", () => {
  it("says so, stops trying, and pairs again with both codes on Repair", async () => {
    const box = livingRoom();
    const { core } = await home(box);
    await added(core, box);
    const kept = core.secrets.get(`box:${box.key}`);
    const before = box.connects;
    box.forget();
    expect(core.problems.has(box.key)).toBe(false);
    await core.until(
      () => core.problems.get(box.key)?.id === "pairingLost",
      "lost",
    );
    const tries = box.connects;
    expect(tries).toBe(before + 1);
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

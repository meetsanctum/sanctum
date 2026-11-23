import { afterEach, describe, expect, it } from "vitest";

import type { SpeakerState } from "../src/speaker.js";
import { add, announce, startHome } from "./support.js";
import { player, voicePe } from "./voice-pe.js";

// A smart speaker's own parts on ESPHome's page: its microphones, which its
// side switch can hold muted, its ring's glow, colour and brightness, and
// when it last heard its wake word, kept across restarts. Neither part is
// a capability, so neither reaches the rest of the home.

let home: Awaited<ReturnType<typeof startHome>>;

afterEach(async () => {
  await home?.stop();
});

/** Waits until what the app answers holds, as the speaker says it. */
async function eventually(check: () => Promise<boolean>, what: string) {
  const end = Date.now() + 2_000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timed out waiting: ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function addedSpeaker() {
  // The heartbeat ticks once a second, and an unmute can take two.
  home = await startHome({ offlineMs: 3_000 });
  const device = await voicePe(home);
  const key = await add(home.core, device);
  const id = `device:${key}`;
  const read = async () =>
    (await home.core.call("esphome.speaker", { device: id })) as SpeakerState;
  const change = (input: object) =>
    home.core.call("esphome.changeSpeaker", { device: id, ...input });
  await eventually(async () => {
    const now = await read();
    return now.ring !== null && now.microphones !== null;
  }, "its parts");
  await home.core.until(() => device.voiceFollowed, "its requests followed");
  return { device, key, id, read, change };
}

describe("a smart speaker's page", () => {
  it("shows its microphones on and its ring as it ships, and nothing heard yet", async () => {
    const { read } = await addedSpeaker();

    expect(await read()).toEqual({
      microphones: true,
      ring: { glow: false, colour: "#18bbf2", brightness: 66 },
      heardWakeWordAt: null,
    });
  });

  it("leaves out of what it also has the parts it shows, and what it hides by default", async () => {
    const { id } = await addedSpeaker();

    expect(
      await home.core.call("esphome.device", { device: id }),
    ).toMatchObject({ unused: ["Wake sound"] });
  });

  it("mutes and unmutes its microphones", async () => {
    const { device, read, change } = await addedSpeaker();

    await change({ microphones: false });
    expect(device.states[203]).toMatchObject({ state: true });
    expect((await read()).microphones).toBe(false);
    await change({ microphones: true });
    expect((await read()).microphones).toBe(true);
  });

  it("refuses to turn on microphones its side switch holds muted", async () => {
    const { device, read, change } = await addedSpeaker();
    device.held.set(203, { state: true });
    device.setState(203, { state: true });
    await eventually(
      async () => (await read()).microphones === false,
      "muted by its side",
    );

    await expect(change({ microphones: true })).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await read()).microphones).toBe(false);
  });

  it("changes its ring's glow, colour and brightness, each alone", async () => {
    const { device, read, change } = await addedSpeaker();

    await change({ ring: { colour: "#ff9f0a" } });
    await eventually(
      async () => (await read()).ring?.colour === "#ff9f0a",
      "orange",
    );
    // A ring that doesn't glow keeps its colour for when it's busy.
    expect(device.states[204]).toMatchObject({ state: false });

    await change({ ring: { brightness: 40 } });
    await change({ ring: { glow: true } });
    await eventually(async () => {
      const ring = (await read()).ring;
      return ring?.glow === true && ring.brightness === 40;
    }, "glowing at 40 %");
    expect((await read()).ring?.colour).toBe("#ff9f0a");
  });

  it("keeps glow on when brightness changes in quick succession", async () => {
    const { device, read, change } = await addedSpeaker();

    await Promise.all([
      change({ ring: { glow: true } }),
      change({ ring: { brightness: 40 } }),
    ]);

    expect(device.commands.at(-1)?.fields).not.toHaveProperty("state");
    expect((await read()).ring).toMatchObject({ glow: true, brightness: 40 });
  });

  it("waits for the ring to report the requested brightness", async () => {
    const { device, read, change } = await addedSpeaker();
    device.held.set(204, { brightness: 0.66 });
    let settled = false;
    const write = change({ ring: { brightness: 40 } }).finally(() => {
      settled = true;
    });

    await home.core.until(() => device.commands.length > 0, "brightness sent");
    expect(settled).toBe(false);
    expect((await read()).ring?.brightness).toBe(66);
    device.held.delete(204);
    device.setState(204, { brightness: 0.4 });
    await write;
    expect((await read()).ring?.brightness).toBe(40);
  });

  it("drops microphone state from the old session after reconnecting", async () => {
    const { device, read } = await addedSpeaker();
    expect((await read()).microphones).toBe(true);

    delete device.states[203];
    device.reboot();
    await announce(home.core, device);
    await home.core.until(() => device.voiceFollowed, "followed again");

    expect((await read()).microphones).toBeNull();
  });

  it("records only wake words and keeps the timestamp after an app restart", async () => {
    const { device, read } = await addedSpeaker();
    device.wake(null);
    await home.core.until(
      () => device.voiceMessages.length === 2,
      "button run ended",
    );
    expect((await read()).heardWakeWordAt).toBeNull();
    const before = Date.now();

    device.wake();
    await eventually(
      async () => (await read()).heardWakeWordAt !== null,
      "heard",
    );
    const heard = (await read()).heardWakeWordAt!;
    expect(heard).toBeGreaterThanOrEqual(before);
    expect(heard).toBeLessThanOrEqual(Date.now());

    await device.unplug();
    await home.core.stop();
    await home.core.start();
    expect(await read()).toEqual({
      microphones: null,
      ring: null,
      heardWakeWordAt: heard,
    });
  });

  it("tracks the wake word of a speaker without microphone or ring controls", async () => {
    home = await startHome();
    const device = await home.plugIn({
      voiceAssistant: true,
      entities: [player],
    });
    const key = await add(home.core, device);
    await home.core.until(() => device.voiceFollowed, "its requests followed");
    const read = () =>
      home.core.call("esphome.speaker", {
        device: `device:${key}`,
      }) as Promise<SpeakerState>;

    device.wake();
    await eventually(
      async () => (await read()).heardWakeWordAt !== null,
      "heard",
    );
    expect(await read()).toMatchObject({ microphones: null, ring: null });
  });

  it("isn't a smart speaker's page on another device", async () => {
    home = await startHome();
    const device = await home.plugIn({ kind: "switch" });
    const key = await add(home.core, device);

    await expect(
      home.core.call("esphome.speaker", { device: `device:${key}` }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

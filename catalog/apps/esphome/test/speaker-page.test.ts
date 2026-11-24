import { afterEach, describe, expect, it } from "vitest";

import type { SpeakerState } from "../src/speaker.js";
import { add, announce, startHome } from "./support.js";
import { player, voicePe } from "./voice-pe.js";

// A smart speaker's own parts: its microphones, its `audio` part in the
// core, which its side switch can hold muted and which carries when it last
// heard its wake word, kept across restarts; and on ESPHome's page its
// ring's glow, colour and brightness, which never reaches the rest of the
// home.

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
  // The page's change, by the action it calls for it.
  const change = async (input: { ring: object }) => {
    await home.core.call("esphome.changeRing", { device: id, ...input.ring });
  };
  const audio = () => home.core.latest(key, "audio");
  const mute = (muted: boolean) =>
    home.core.command(key, "audio", "audio", { muted });
  await eventually(async () => (await read()).ring !== null, "its ring");
  await home.core.until(() => audio() !== undefined, "its microphones");
  await home.core.until(() => device.voiceFollowed, "its requests followed");
  return { device, key, id, read, change, audio, mute };
}

describe("a smart speaker's page", () => {
  it("has its microphones on and its ring as it ships, and nothing heard yet", async () => {
    const { read, audio } = await addedSpeaker();

    expect(audio()).toEqual({ muted: false });
    expect(await read()).toEqual({
      ring: { glow: false, colour: "#18bbf2", brightness: 66 },
    });
  });

  it("registers its microphones as its audio part, which can be muted", async () => {
    const { key } = await addedSpeaker();

    expect(
      home.core.registered
        .get(key)
        ?.capabilities.find((each) => each.kind === "audio"),
    ).toEqual({
      id: "audio",
      kind: "audio",
      features: { mutes: true, muteSwitch: true },
    });
  });

  it("leaves out of what it also has the parts it shows, and what it hides by default", async () => {
    const { id } = await addedSpeaker();

    expect(
      await home.core.call("esphome.device", { device: id }),
    ).toMatchObject({ unused: ["Wake sound"] });
  });

  it("mutes and unmutes its microphones", async () => {
    const { device, audio, mute } = await addedSpeaker();

    await mute(true);
    await home.core.until(() => audio()?.muted === true, "muted");
    expect(device.states[203]).toMatchObject({ state: true });
    await mute(false);
    await home.core.until(() => audio()?.muted === false, "unmuted");
  });

  it("stays muted while its side switch holds it", async () => {
    const { device, audio, mute } = await addedSpeaker();
    device.held.set(203, { state: true });
    device.setState(203, { state: true });
    await home.core.until(() => audio()?.muted === true, "muted by its side");

    await mute(false);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(audio()?.muted).toBe(true);
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

  it("requires a ring setting to change", async () => {
    const { change } = await addedSpeaker();

    await expect(change({ ring: {} })).rejects.toThrow(
      "Give at least one ring setting",
    );
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

  it("drops ring state from the old session after reconnecting", async () => {
    const { device, read } = await addedSpeaker();
    expect((await read()).ring).not.toBeNull();

    delete device.states[204];
    device.reboot();
    await announce(home.core, device);
    await home.core.until(() => device.voiceFollowed, "followed again");

    expect((await read()).ring).toBeNull();
  });

  it("says when it heard its wake word, never a button's press, and keeps it after a restart", async () => {
    const { device, audio } = await addedSpeaker();
    device.wake(null);
    await home.core.until(
      () => device.voiceMessages.length === 2,
      "button run ended",
    );
    expect(audio()?.heardAt).toBeUndefined();
    const before = Date.now();

    device.wake();
    await home.core.until(() => audio()?.heardAt !== undefined, "heard");
    const heardAt = audio()!.heardAt as string;
    const heard = Date.parse(heardAt);
    expect(heard).toBeGreaterThanOrEqual(before);
    expect(heard).toBeLessThanOrEqual(Date.now());
    expect(audio()?.muted).toBe(false);

    await home.core.stop();
    home.core.reports.length = 0;
    await home.core.start();
    await announce(home.core, device);
    await home.core.until(
      () =>
        home.core.reports.some(
          (each) => each.states.audio?.heardAt === heardAt,
        ),
      "said again",
    );
  });

  it("has microphones that can't be muted without a Mute switch, and says when it heard", async () => {
    home = await startHome();
    const device = await home.plugIn({
      voiceAssistant: true,
      entities: [player],
    });
    const key = await add(home.core, device);
    await home.core.until(() => device.voiceFollowed, "its requests followed");
    const registered = home.core.registered.get(key);

    expect(registered?.type).toBe("smart-speaker");
    expect(
      registered?.capabilities.find((each) => each.kind === "audio"),
    ).toEqual({
      id: "audio",
      kind: "audio",
      features: { mutes: false, muteSwitch: false },
    });
    device.wake();
    await home.core.until(
      () => home.core.latest(key, "audio")?.heardAt !== undefined,
      "heard",
    );
    expect(home.core.latest(key, "audio")?.muted).toBeUndefined();
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

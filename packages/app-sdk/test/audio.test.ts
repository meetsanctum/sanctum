import { describe, expect, it } from "vitest";

import {
  audio,
  capabilityRegistration,
  controlPermission,
  deviceCategoryOf,
  deviceTypeOf,
  historyFields,
  permissionWords,
  readPermission,
} from "../src/index.js";

// A smart speaker's microphones: whether they can be muted and have a
// switch of their own, whether they are muted and when it last heard its
// wake word, and the one command that mutes or unmutes them.

describe("a smart speaker's microphones", () => {
  it("can't be muted unless its driver says so", () => {
    expect(
      capabilityRegistration.parse({ id: "audio", kind: "audio" }),
    ).toEqual({
      id: "audio",
      kind: "audio",
      features: { mutes: false, muteSwitch: false },
    });
    expect(audio.supports(audio.features.parse({}))).toBe(false);
    expect(audio.supports(audio.features.parse({ mutes: true }))).toBe(true);
  });

  it("say whether they're muted and when it heard its wake word", () => {
    expect(
      audio.state.parse({ muted: true, heardAt: "2026-11-24T09:05:00.000Z" }),
    ).toEqual({ muted: true, heardAt: "2026-11-24T09:05:00.000Z" });
    expect(audio.state.parse({})).toEqual({});
    expect(() => audio.state.parse({ heardAt: "yesterday" })).toThrow();
    expect(() => audio.state.parse({ heard: "what was said" })).toThrow();
  });

  it("are muted or unmuted, which the speaker's report confirms", () => {
    expect(audio.desired({ muted: true })).toEqual({ muted: true });
    expect(() => audio.command.parse({})).toThrow();
    expect(audio.tier).toBe("write");
  });

  it("make a device a smart speaker, under Media, with no history and their own permissions", () => {
    expect(deviceTypeOf(["audio"])).toBe("smart-speaker");
    expect(deviceCategoryOf("audio")?.id).toBe("media");
    expect(historyFields.audio).toEqual([]);
    expect(permissionWords(readPermission("audio"))?.title).toBe(
      "See your smart speakers' microphones",
    );
    expect(permissionWords(controlPermission("audio"))?.title).toBe(
      "Mute your smart speakers' microphones",
    );
  });
});

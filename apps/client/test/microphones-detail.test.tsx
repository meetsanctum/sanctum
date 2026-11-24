// @vitest-environment jsdom
import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import {
  heardWords,
  MicrophonesPage,
  type Audio,
} from "../src/microphones-detail";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

// A smart speaker's Microphones page: its microphones' switch, which mutes
// them through core Devices and when it last heard its wake word.

const device = {
  id: "device:speaker",
  availability: "online",
  type: "smart-speaker",
} as DeviceInfo;

const now = new Date(2026, 10, 24, 12, 0);

function audio(change: Partial<Audio> = {}): Audio {
  return {
    id: "audio",
    kind: "audio",
    features: { mutes: true, muteSwitch: true },
    state: { muted: false },
    observed: { muted: false },
    desired: null,
    sync: "synced",
    setBy: null,
    changedAt: null,
    ...change,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(coreJson).mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

async function show(capability: Audio, shown: DeviceInfo = device) {
  await act(async () => {
    root.render(
      <MicrophonesPage device={shown} capabilities={[capability]} now={now} />,
    );
  });
}

const microphones = () =>
  container.querySelector<HTMLButtonElement>('[role="switch"]');

describe("a smart speaker's Microphones page", () => {
  it("shows its microphones on and that it hasn't heard its wake word", async () => {
    await show(audio());

    expect(container.querySelector("h2")?.textContent).toBe("Microphones");
    expect(microphones()?.getAttribute("aria-checked")).toBe("true");
    expect(container.textContent).toContain("Heard its wake wordNot yet");
    expect(container.textContent).toContain(
      "The switch on its side mutes the microphones too",
    );
  });

  it("mutes them through core Devices", async () => {
    vi.mocked(coreJson).mockResolvedValue(audio({ sync: "pending" }));
    await show(audio());

    await act(async () => microphones()!.click());

    expect(coreJson).toHaveBeenCalledWith("/api/devices/command", {
      method: "POST",
      json: {
        device: "device:speaker",
        capability: "audio",
        command: { muted: true },
      },
    });
  });

  it("waits while a change is on its way", async () => {
    await show(
      audio({
        sync: "pending",
        state: { muted: true },
        desired: { muted: true },
      }),
    );

    expect(microphones()?.disabled).toBe(true);
    expect(microphones()?.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Muting…",
    );
  });

  it("shows a timeout and gives conditional help for a physical switch", async () => {
    await show(
      audio({
        state: { muted: true },
        observed: { muted: true },
        sync: "conflict",
      }),
    );

    expect(microphones()?.getAttribute("aria-checked")).toBe("false");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "If the switch on its side is on",
    );
  });

  it("shows a timeout on a speaker without a physical switch", async () => {
    await show(
      audio({
        features: { mutes: true, muteSwitch: false },
        sync: "conflict",
      }),
    );

    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Couldn't change the microphones. Try again.",
    );
  });

  it("shows mute status for a speaker with a physical-only switch", async () => {
    await show(
      audio({
        features: { mutes: false, muteSwitch: true },
        observed: { muted: true },
        state: { muted: true },
      }),
    );

    expect(microphones()).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      "Muted",
    );
  });

  it("says so when the core can't take the change", async () => {
    vi.mocked(coreJson).mockRejectedValue(new Error("offline"));
    await show(audio());

    await act(async () => microphones()!.click());

    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      "Couldn't change the microphones.",
    );
  });

  it("has no switch where they can't be muted, and no side switch's words", async () => {
    await show(
      audio({
        features: { mutes: false, muteSwitch: false },
        observed: { heardAt: new Date(2026, 10, 24, 9, 5).toISOString() },
      }),
    );

    expect(microphones()).toBeNull();
    expect(container.textContent).toContain(
      "Heard its wake wordToday at 09:05",
    );
    expect(container.textContent).not.toContain("on its side");
  });

  it("can't be switched while it's offline", async () => {
    await show(audio(), { ...device, availability: "offline" });

    expect(microphones()?.disabled).toBe(true);
  });
});

describe("when it last heard its wake word", () => {
  it("says the day in words", () => {
    expect(heardWords(undefined, now)).toBe("Not yet");
    expect(heardWords(new Date(2026, 10, 24, 9, 5).toISOString(), now)).toBe(
      "Today at 09:05",
    );
    expect(heardWords(new Date(2026, 10, 23, 21, 14).toISOString(), now)).toBe(
      "Yesterday at 21:14",
    );
    expect(heardWords(new Date(2026, 10, 17, 7, 30).toISOString(), now)).toBe(
      "17 Nov at 07:30",
    );
  });

  it("counts calendar days over both daylight-saving changes", () => {
    const zone = "Europe/Zurich";
    expect(
      heardWords("2026-03-28T20:00Z", new Date("2026-03-29T22:30Z"), zone),
    ).toBe("28 Mar at 21:00");
    expect(
      heardWords("2026-10-24T20:00Z", new Date("2026-10-25T22:30Z"), zone),
    ).toBe("Yesterday at 22:00");
  });
});

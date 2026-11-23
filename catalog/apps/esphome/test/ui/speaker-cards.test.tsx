// @vitest-environment jsdom
import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { AppScope, type AppClient } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviceFacts } from "../../src/facts";
import type { SpeakerState } from "../../src/speaker";
import { heardWords, ringColourOf } from "../../src/ui/speaker-cards";
import ui from "../../src/ui/index";

// A smart speaker's page: Listening, with its microphones and when it last
// heard its wake word, and Ring, above how it's connected. Turning on
// microphones its side switch holds muted says how to free them.

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const device = {
  id: "device:1",
  availability: "online",
  type: "smart-speaker",
} as DeviceInfo;

const facts: DeviceFacts = {
  address: "192.168.1.47:6053",
  encrypted: true,
  version: "2026.6.0",
  signal: -58,
  unused: ["Wake sound"],
  sleeps: false,
  firstKey: "setup",
  heardWakeWordAt: null,
};

let root: Root;
let host: HTMLDivElement;
let speaker: SpeakerState;
let changes: object[];
let refuse: string | null;

beforeEach(() => {
  // Radix's slider measures itself.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  speaker = {
    microphones: true,
    ring: { glow: false, colour: "#18bbf2", brightness: 66 },
    heardWakeWordAt: null,
  };
  changes = [];
  refuse = null;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

async function show(shown: DeviceInfo = device) {
  const client = {
    async call(id: string, input: { device: string }) {
      expect(input.device).toBe("device:1");
      if (id === "esphome.device") return facts;
      if (id === "esphome.speaker") return speaker;
      if (id === "esphome.changeSpeaker") {
        const { device: _device, ...change } = input;
        changes.push(change);
        if (refuse) throw Object.assign(new Error(refuse), { code: refuse });
        return {};
      }
      throw new Error(`No ${id}`);
    },
  } as unknown as AppClient;
  const Page = ui.devicePages!["esphome.device"]!;
  await act(async () => {
    root.render(
      <AppScope client={client}>
        <Page device={shown} />
      </AppScope>,
    );
  });
}

const headings = () =>
  [...host.querySelectorAll("h2")].map((each) => each.textContent);
const switchFor = (label: string) =>
  host.querySelector<HTMLButtonElement>(
    `[role="switch"][id="${[...host.querySelectorAll("label")].find((each) => each.textContent?.startsWith(label))?.htmlFor}"]`,
  )!;
const click = (element: Element) =>
  act(async () => {
    (element as HTMLElement).click();
  });

describe("a smart speaker's page", () => {
  it("shows Listening and Ring above how it's connected", async () => {
    await show();

    expect(headings()).toEqual(["Listening", "Ring"]);
    expect(switchFor("Microphones").getAttribute("aria-checked")).toBe("true");
    expect(host.textContent).toContain("Heard its wake wordNot yet");
    expect(switchFor("Glow while waiting").getAttribute("aria-checked")).toBe(
      "false",
    );
    const chosen = host.querySelector('[role="radio"][aria-checked="true"]');
    expect(chosen?.getAttribute("aria-label")).toBe("Sky blue");
    expect(host.textContent).toContain("66 %");
    expect(host.textContent).toContain("It also has Wake sound");
  });

  it("shows neither on a device that isn't a smart speaker", async () => {
    await show({ ...device, type: "switch" } as DeviceInfo);

    expect(headings()).toEqual([]);
    expect(host.textContent).toContain("Encrypted");
  });

  it("mutes its microphones and picks the ring's colour", async () => {
    await show();

    await click(switchFor("Microphones"));
    await click(host.querySelector('[aria-label="Orange"]')!);

    expect(changes).toEqual([
      { microphones: false },
      { ring: { colour: "#ff9f0a" } },
    ]);
  });

  it("says how to free microphones its side switch holds muted", async () => {
    speaker.microphones = false;
    refuse = "conflict";
    await show();

    await click(switchFor("Microphones"));

    expect(host.querySelector('[role="alert"]')?.textContent).toContain(
      "They're still muted. Turn off the switch on its side to turn them on.",
    );
    expect(switchFor("Microphones").getAttribute("aria-checked")).toBe("false");
  });
});

describe("its words", () => {
  it("say when it last heard its wake word", () => {
    const now = new Date(2026, 10, 23, 12, 0);
    expect(heardWords(null, now)).toBe("Not yet");
    expect(heardWords(new Date(2026, 10, 23, 9, 5).getTime(), now)).toBe(
      "Today at 09:05",
    );
    expect(heardWords(new Date(2026, 10, 22, 21, 14).getTime(), now)).toBe(
      "Yesterday at 21:14",
    );
    expect(heardWords(new Date(2026, 10, 17, 7, 30).getTime(), now)).toBe(
      "17 Nov at 07:30",
    );
  });

  it("take a colour the speaker rounded as the ring's own", () => {
    expect(ringColourOf("#18bbf2")).toBe("#18bbf2");
    expect(ringColourOf("#17bbf1")).toBe("#18bbf2");
    expect(ringColourOf("#123456")).toBeNull();
  });
});

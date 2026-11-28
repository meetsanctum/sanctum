// @vitest-environment jsdom
import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { AppScope, type AppClient } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { DeviceFacts } from "../../src/facts";
import type { SpeakerState } from "../../src/speaker";
import { ringColourOf } from "../../src/ui/speaker-cards";
import ui from "../../src/ui/index";

// A smart speaker's page: Ring, above how it's connected. Its microphones
// are the shell's.

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
};

let root: Root;
let host: HTMLDivElement;
let speaker: SpeakerState;
let changes: object[];
let refuse: string | null;
let isReadFailing: boolean;
let reads: number;
let writeGate: Promise<void> | undefined;

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
  speaker = { ring: { glow: false, colour: "#18bbf2", brightness: 66 } };
  changes = [];
  refuse = null;
  isReadFailing = false;
  reads = 0;
  writeGate = undefined;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function show(shown: DeviceInfo = device) {
  const client = {
    async call(id: string, input: { device: string }) {
      expect(input.device).toBe("device:1");
      if (id === "esphome.device") return facts;
      if (id === "esphome.speaker") {
        reads += 1;
        if (isReadFailing) throw new Error("Can't read its state");
        return speaker;
      }
      const change =
        id === "esphome.changeRing"
          ? (({ device: _device, ...ring }) => ({ ring }))(input)
          : null;
      if (change) {
        changes.push(change);
        await writeGate;
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
  it("shows Ring above how it's connected", async () => {
    await show();

    expect(headings()).toEqual(["Ring"]);
    expect(host.textContent).not.toContain("Microphones");
    expect(switchFor("Glow while waiting").getAttribute("aria-checked")).toBe(
      "false",
    );
    const chosen = host.querySelector('[role="radio"][aria-checked="true"]');
    expect(chosen?.getAttribute("aria-label")).toBe("Sky blue");
    expect(host.textContent).toContain("66 %");
    const slider = host.querySelector('[role="slider"]');
    expect(
      document.getElementById(slider?.getAttribute("aria-labelledby") ?? "")
        ?.textContent,
    ).toBe("Brightness");
    expect(host.textContent).toContain("It also has Wake sound");
  });

  it("shows no ring on a device that isn't a smart speaker", async () => {
    await show({ ...device, type: "switch" } as DeviceInfo);

    expect(headings()).toEqual([]);
    expect(host.textContent).toContain("Encrypted");
  });

  it("picks the ring's colour", async () => {
    await show();

    await click(host.querySelector('[aria-label="Orange"]')!);

    expect(changes).toEqual([{ ring: { colour: "#ff9f0a" } }]);
  });

  it("keeps the requested ring setting visible until the write completes", async () => {
    vi.useFakeTimers();
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    let release!: () => void;
    writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await show();

    await click(switchFor("Glow while waiting"));
    await act(async () => vi.advanceTimersByTimeAsync(5_000));
    expect(reads).toBe(1);
    expect(switchFor("Glow while waiting").getAttribute("aria-checked")).toBe(
      "true",
    );

    speaker.ring = { ...speaker.ring!, glow: true };
    await act(async () => release());
    expect(reads).toBe(2);
    expect(switchFor("Glow while waiting").getAttribute("aria-checked")).toBe(
      "true",
    );
  });

  it("rolls back a failed write when it cannot read the speaker again", async () => {
    await show();
    refuse = "unavailable";
    isReadFailing = true;

    await click(switchFor("Glow while waiting"));

    expect(switchFor("Glow while waiting").getAttribute("aria-checked")).toBe(
      "false",
    );
    expect(
      [
        ...host.querySelectorAll(
          '[role="alert"] [data-slot=alert-title], [role="alert"] [data-slot=alert-description]',
        ),
      ].map((line) => line.textContent),
    ).toEqual([
      "Its ring didn't change",
      "ESPHome couldn't change it. Try again in a moment.",
    ]);
  });

  it("restores brightness when a keyboard adjustment fails", async () => {
    await show();
    refuse = "unavailable";
    const slider = host.querySelector<HTMLElement>('[role="slider"]')!;
    await act(async () => {
      slider.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "ArrowRight",
          bubbles: true,
          cancelable: true,
        }),
      );
    });

    expect(changes).toEqual([{ ring: { brightness: 67 } }]);
    expect(slider.getAttribute("aria-valuenow")).toBe("66");
  });

  it("moves from the focused colour after a selection fails", async () => {
    await show();
    const skyBlue = host.querySelector<HTMLButtonElement>(
      '[aria-label="Sky blue"]',
    )!;
    const warmWhite = host.querySelector<HTMLButtonElement>(
      '[aria-label="Warm white"]',
    )!;
    const arrowRight = (element: HTMLElement) =>
      act(async () => {
        element.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        );
      });
    refuse = "unavailable";

    skyBlue.focus();
    await arrowRight(skyBlue);
    expect(document.activeElement).toBe(warmWhite);
    expect(skyBlue.getAttribute("aria-checked")).toBe("true");

    refuse = null;
    await arrowRight(warmWhite);
    expect(changes).toEqual([
      { ring: { colour: "#ffd9a8" } },
      { ring: { colour: "#30d158" } },
    ]);
  });

  it("shows nothing of its own while its ring is unknown", async () => {
    speaker = { ring: null };
    await show({ ...device, availability: "offline" });

    expect(headings()).toEqual([]);
    expect(host.querySelector('[role="switch"]')).toBeNull();
  });
});

describe("its words", () => {
  it("take a colour the speaker rounded as the ring's own", () => {
    expect(ringColourOf("#18bbf2")).toBe("#18bbf2");
    expect(ringColourOf("#17bbf1")).toBe("#18bbf2");
    expect(ringColourOf("#19c5ff")).toBe("#18bbf2");
    expect(ringColourOf("#38fdff")).toBeNull();
    expect(ringColourOf("#c66aff")).toBe("#c468f5");
    expect(ringColourOf("#123456")).toBeNull();
  });
});

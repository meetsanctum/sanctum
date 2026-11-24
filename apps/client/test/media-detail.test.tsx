// @vitest-environment jsdom
import type { DeviceInfo, MediaCommand } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Media } from "../src/media";
import { MediaPlaying, MediaRemote, MediaVolume } from "../src/media-detail";
import { mediaPlayer } from "./place-pages-fixtures";

// A media player's pages in its detail: Playing with what plays and its
// buttons, dimmed and empty while off; a TV's Remote with its power and
// volume steps; a speaker's Volume with mute and its level.

const show = {
  title: "The Long Way Round",
  series: "The Long Way Round",
  season: 2,
  episode: 4,
  duration: 2700,
  position: 1032,
};

let container: HTMLDivElement;
let root: Root;
let sent: MediaCommand[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  sent = [];
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

type Page = typeof MediaPlaying;

async function render(
  Page: Page,
  device: DeviceInfo,
  disabled = false,
  artwork?: string,
) {
  await act(async () => {
    root.render(
      <Page
        name={device.name}
        device={device}
        capability={device.capabilities[0] as Media}
        disabled={disabled}
        artwork={artwork ?? null}
        isArtworkMissing={false}
        onArtworkError={() => {}}
        onCommand={(command) => sent.push(command)}
      />,
    );
  });
}

const button = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

const seekBar = () =>
  container.querySelector<HTMLInputElement>('input[type="range"]');

const pointer = (type: string, clientX = 0) =>
  new PointerEvent(type, {
    bubbles: true,
    pointerId: 1,
    isPrimary: true,
    clientX,
  });

function changeRange(slider: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    "value",
  )!.set!.call(slider, value);
  slider.dispatchEvent(new Event("input", { bubbles: true }));
}

async function press(label: string) {
  await act(async () => button(label)!.click());
}

describe("Playing", () => {
  it("sizes each replacement image independently", async () => {
    const device = mediaPlayer("box", "Living Room TV", "office", {
      on: true,
      activity: "paused",
      media: show,
    });
    const image = () => container.querySelector("img");
    await render(MediaPlaying, device, false, "blob:portrait");
    const portrait = image()!;
    Object.defineProperties(portrait, {
      naturalWidth: { value: 100 },
      naturalHeight: { value: 200 },
    });
    await act(async () => portrait.dispatchEvent(new Event("load")));
    expect(portrait.style.getPropertyValue("--artwork-width")).toBe(
      "min(300px, 132px)",
    );

    await render(MediaPlaying, device, false, "blob:replacement");
    expect(image()!.style.getPropertyValue("--artwork-width")).toBe(
      "min(300px, 469px)",
    );
  });

  it("shows what plays, where it is, and pauses it", async () => {
    await render(
      MediaPlaying,
      mediaPlayer("box", "Living Room TV", "office", {
        on: true,
        activity: "paused",
        app: { id: "tv.example", name: "TV" },
        media: show,
      }),
    );
    const text = container.textContent ?? "";
    expect(text).toContain("The Long Way Round");
    expect(text).toContain("Season 2, episode 4 · TV");
    expect(text).toContain("17:12");
    expect(text).toContain("−27:48");

    await press("Play Living Room TV");
    await press("Next");
    await press("Previous");
    expect(sent).toEqual([
      { activity: "playing" },
      { playback: "next" },
      { playback: "previous" },
    ]);
  });

  it("plays or pauses with Space, but not from a field or a button", async () => {
    await render(
      MediaPlaying,
      mediaPlayer("box", "Living Room TV", "office", {
        on: true,
        activity: "playing",
        media: show,
      }),
    );
    const space = (on: EventTarget) =>
      act(async () => {
        on.dispatchEvent(
          new KeyboardEvent("keydown", { key: " ", bubbles: true }),
        );
      });
    await space(document.body);
    // A button pressed with Space presses only itself.
    await space(button("Next")!);
    container.setAttribute("inert", "");
    await space(document.body);
    expect(sent).toEqual([{ activity: "paused" }]);
  });

  it("sends a seek only for a range edit or a completed drag", async () => {
    await render(
      MediaPlaying,
      mediaPlayer("box", "Living Room TV", "office", {
        on: true,
        activity: "paused",
        media: show,
      }),
    );
    const slider = seekBar()!;
    const rail = slider.parentElement!;
    rail.getBoundingClientRect = () => new DOMRect(0, 0, 2700, 24);
    await act(async () => {
      slider.dispatchEvent(
        new KeyboardEvent("keyup", { key: "Tab", bubbles: true }),
      );
    });
    expect(sent).toEqual([]);
    await act(async () => changeRange(slider, "1033"));
    expect(sent).toEqual([{ position: 1033 }]);
    await act(async () => {
      rail.dispatchEvent(pointer("pointerdown", 1033));
      rail.dispatchEvent(pointer("pointermove", 1500));
    });
    expect(slider.value).toBe("1500");
    expect(sent).toHaveLength(1);
    await act(async () => rail.dispatchEvent(pointer("pointercancel")));
    expect(sent).toHaveLength(1);

    await act(async () => rail.dispatchEvent(pointer("pointerdown", 1033)));
    await act(async () => rail.dispatchEvent(pointer("pointerup", 1800)));
    expect(sent).toEqual([{ position: 1033 }, { position: 1800 }]);
  });

  it("shows elapsed time for a stream without a duration", async () => {
    await render(
      MediaPlaying,
      mediaPlayer("box", "Living Room TV", "office", {
        on: true,
        activity: "playing",
        media: { title: "The News", position: 65 },
      }),
    );
    expect(container.textContent).toContain("1:05");
    expect(seekBar()).toBeNull();
  });

  it("uses the reported playback state for the timer while a pause is pending", async () => {
    vi.useFakeTimers();
    const device = mediaPlayer("box", "Living Room TV", "office", {
      on: true,
      activity: "playing",
      media: {
        ...show,
        positionAt: new Date(Date.now() - 60_000).toISOString(),
      },
    });
    const capability = device.capabilities[0] as Media;
    capability.sync = "pending";
    capability.state = { ...capability.state!, activity: "paused" };
    await render(MediaPlaying, device);
    expect(container.textContent).toContain("18:12");
    expect(button("Play Living Room TV")).not.toBeNull();
  });

  it("ignores stale programme metadata when playback is idle", async () => {
    await render(
      MediaPlaying,
      mediaPlayer("box", "Living Room TV", "office", {
        on: true,
        activity: "idle",
        media: show,
      }),
    );
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).not.toContain(show.title);
    expect(button("Next")!.disabled).toBe(true);
    expect(seekBar()).toBeNull();
  });

  it("draws the empty picture, with no words, in the frame a picture of that shape gets", async () => {
    const frame = () =>
      container
        .querySelector<HTMLElement>('[style*="--artwork-width"]')
        ?.style.getPropertyValue("--artwork-width");
    await render(
      MediaPlaying,
      mediaPlayer("box", "Living Room TV", "office", {
        on: true,
        activity: "idle",
      }),
    );
    expect(frame()).toBe("min(300px, 469px)");
    await render(
      MediaPlaying,
      mediaPlayer(
        "speaker",
        "Office Speaker",
        "office",
        { activity: "idle" },
        { power: false },
        "smart-speaker",
      ),
    );
    expect(frame()).toBe("min(300px, 264px)");
    expect(container.textContent).not.toContain("Nothing playing");
  });

  it("keeps its shape while off, dimmed and empty, with nothing to press", async () => {
    await render(
      MediaPlaying,
      mediaPlayer("box", "Living Room TV", "office", {
        on: false,
        activity: "idle",
        media: show,
      }),
    );
    const text = container.textContent ?? "";
    expect(container.querySelector("img")).toBeNull();
    expect(text).not.toContain("The Long Way Round");
    expect(text).toContain("–:––");
    expect(button("Play Living Room TV")!.disabled).toBe(true);
    expect(button("Next")!.disabled).toBe(true);
    // Power is on Remote, never here.
    expect(button("Turn on Living Room TV")).toBeNull();
  });

  it("shows a speaker's play alone, since it takes no previous or next", async () => {
    await render(
      MediaPlaying,
      mediaPlayer(
        "speaker",
        "Office Speaker",
        "office",
        { activity: "idle" },
        { power: false, playback: ["play", "pause", "stop"], volume: "level" },
        "smart-speaker",
      ),
    );
    expect(button("Play Office Speaker")!.disabled).toBe(true);
    expect(button("Next")).toBeNull();
    expect(button("Previous")).toBeNull();
  });
});

describe("Remote", () => {
  it("repeats a held volume step while visible and skips the release click", async () => {
    vi.useFakeTimers();
    await render(
      MediaRemote,
      mediaPlayer("box", "Living Room TV", "office", {
        on: true,
        activity: "paused",
      }),
    );
    const up = button("Turn the volume up")!;
    await act(async () => {
      up.dispatchEvent(pointer("pointerdown"));
      vi.advanceTimersByTime(700);
      up.dispatchEvent(pointer("pointerup"));
      up.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(sent).toEqual([{ volumeStep: "up" }, { volumeStep: "up" }]);
    await act(async () => {
      up.dispatchEvent(pointer("pointerdown"));
      container.setAttribute("inert", "");
      vi.advanceTimersByTime(1000);
    });
    expect(sent).toHaveLength(2);
  });

  it("turns the TV off and steps its volume", async () => {
    await render(
      MediaRemote,
      mediaPlayer("box", "Living Room TV", "office", {
        on: true,
        activity: "playing",
      }),
    );
    expect(
      button("Turn off Living Room TV")!.getAttribute("aria-pressed"),
    ).toBe("true");
    await press("Turn off Living Room TV");
    await press("Turn the volume up");
    await press("Turn the volume down");
    expect(sent).toEqual([
      { on: false },
      { volumeStep: "up" },
      { volumeStep: "down" },
    ]);
  });

  it("turns it on while off, its volume dimmed", async () => {
    await render(
      MediaRemote,
      mediaPlayer("box", "Living Room TV", "office", {
        on: false,
        activity: "idle",
      }),
    );
    expect(button("Turn the volume up")!.disabled).toBe(true);
    await press("Turn on Living Room TV");
    expect(sent).toEqual([{ on: true }]);
  });

  it("keeps + and − in place, dimmed, where the TV has no volume to step", async () => {
    await render(
      MediaRemote,
      mediaPlayer(
        "box",
        "Gym TV",
        "office",
        { on: true, activity: "idle" },
        { power: true, playback: [], volume: null, mute: false },
      ),
    );
    expect(button("Turn the volume up")!.disabled).toBe(true);
    expect(button("Turn the volume down")!.disabled).toBe(true);
    await press("Turn the volume up");
    await press("Turn off Gym TV");
    expect(sent).toEqual([{ on: false }]);
  });
});

describe("Volume", () => {
  it("mutes a speaker above its level", async () => {
    await render(
      MediaVolume,
      mediaPlayer(
        "speaker",
        "Office Speaker",
        "office",
        { activity: "idle", volume: 40, muted: false },
        {
          power: false,
          playback: ["play", "pause", "stop"],
          volume: "level",
          mute: true,
        },
        "smart-speaker",
      ),
    );
    const slider = container.querySelector<HTMLInputElement>(
      'input[aria-label="Office Speaker volume"]',
    )!;
    expect(slider.value).toBe("40");
    // Mute comes first, above the level.
    expect(
      button("Mute Office Speaker")!.compareDocumentPosition(slider) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    await press("Mute Office Speaker");
    expect(sent).toEqual([{ muted: true }]);
  });

  it("shows a speaker's level dimmed where it has no volume to set", async () => {
    await render(
      MediaVolume,
      mediaPlayer(
        "speaker",
        "Kitchen Speaker",
        "office",
        { activity: "idle" },
        {
          power: false,
          playback: ["play", "pause"],
          volume: null,
          mute: false,
        },
        "media-player",
      ),
    );
    const slider = container.querySelector<HTMLInputElement>(
      'input[aria-label="Kitchen Speaker volume"]',
    )!;
    expect(slider.disabled).toBe(true);
  });
});

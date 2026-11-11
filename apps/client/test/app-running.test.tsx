// @vitest-environment jsdom
import type {
  AppGoBack,
  AppInfo,
  AppRunning,
  AppState,
  StaticManifest,
} from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AppRunningSection,
  processorWords,
  restartsWords,
} from "../src/app-running";
import { clockTime } from "../src/attention";
import { coreJson } from "../src/core-fetch";

// How it's running, near the end of an app's settings: its figures, always
// with their words, and what stopped it last.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const mebibyte = 1024 * 1024;

const app = (state: AppState = "running") =>
  ({
    id: "sanctum.weather",
    name: "Weather",
    version: "0.3.0",
    state,
    run: { since: "2026-11-06T10:00:00.000Z" },
  }) as AppInfo;

const manifest = { runtime: { memory: 128, data: 256 } } as StaticManifest;

const figures: AppRunning = {
  memoryBytes: 64 * mebibyte,
  processor: 12.4,
  dataBytes: 9_000_000,
  restarts: { recent: 0 },
};

let host: HTMLElement;
let root: Root;
let running: AppRunning | null;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  running = figures;
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async () => ({ running }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const show = (shown = app(), lastUpdate: AppGoBack | null = null) =>
  act(async () =>
    root.render(
      <AppRunningSection
        app={shown}
        manifest={manifest}
        lastUpdate={lastUpdate}
      />,
    ),
  );

const row = (title: string) =>
  [...host.querySelectorAll("li")].find((each) =>
    each.textContent?.startsWith(title),
  );

describe("how an app is running", () => {
  it("shows its figures beside what each is limited to", async () => {
    await show();

    expect(row("Memory")?.textContent).toBe(
      "MemoryUp to 128 MB. It restarts if it needs more.64 MB",
    );
    expect(row("Processor")?.textContent).toBe(
      "ProcessorUp to half of one core12%",
    );
    expect(row("Its data")?.textContent).toBe(
      "Its dataIts own space, up to 256 MB9 MB",
    );
  });

  it("draws memory against its limit, for sight only", async () => {
    await show();

    const bar = host.querySelector<HTMLElement>("[data-testid='memory-bar']")!;
    expect(bar.getAttribute("aria-hidden")).toBe("true");
    expect(bar.querySelector<HTMLElement>("span")!.style.width).toBe("50%");
  });

  it("never draws the bar past its end", async () => {
    running = { ...figures, memoryBytes: 200 * mebibyte };
    await show();

    const bar = host.querySelector<HTMLElement>("[data-testid='memory-bar']")!;
    expect(bar.querySelector<HTMLElement>("span")!.style.width).toBe("100%");
  });

  it("puts a dash where the home has no figure", async () => {
    running = {
      memoryBytes: null,
      processor: null,
      dataBytes: null,
      restarts: { recent: 0 },
    };
    await show(app("off"));

    expect(row("Memory")?.textContent).toMatch(/—$/);
    expect(row("Processor")?.textContent).toMatch(/—$/);
    expect(row("Its data")?.textContent).toMatch(/—$/);
    const bar = host.querySelector<HTMLElement>("[data-testid='memory-bar']")!;
    expect(bar.querySelector<HTMLElement>("span")!.style.width).toBe("0%");
  });

  it("draws its limits before the first figures arrive", async () => {
    vi.mocked(coreJson).mockImplementation(() => new Promise(() => undefined));
    await show();

    expect(row("Memory")?.textContent).toContain("Up to 128 MB");
    expect(row("Memory")?.textContent).toMatch(/—$/);
    expect(row("Restarts")?.textContent).toContain("None lately");
  });

  it("asks again while it's open, and stops once it's gone", async () => {
    vi.useFakeTimers();
    await show();
    expect(coreJson).toHaveBeenCalledTimes(1);
    expect(coreJson).toHaveBeenCalledWith("/api/apps/sanctum.weather/running", {
      signal: expect.any(AbortSignal),
    });

    running = { ...figures, memoryBytes: 32 * mebibyte };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(coreJson).toHaveBeenCalledTimes(2);
    expect(row("Memory")?.textContent).toMatch(/32 MB$/);

    await act(async () => root.render(null));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(coreJson).toHaveBeenCalledTimes(2);
  });

  it("asks again at once as its state changes", async () => {
    await show(app("running"));
    await show(app("restarting"));

    expect(coreJson).toHaveBeenCalledTimes(2);
  });

  it("waits for a slow reading before asking again", async () => {
    vi.useFakeTimers();
    let answer!: (value: { running: AppRunning }) => void;
    vi.mocked(coreJson).mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    await show();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(coreJson).toHaveBeenCalledTimes(1);

    await act(async () => answer({ running: figures }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(coreJson).toHaveBeenCalledTimes(2);
    expect(row("Memory")?.textContent).toMatch(/64 MB$/);
  });

  it("cancels a pending reading when its state changes or the page closes", async () => {
    vi.mocked(coreJson).mockImplementation(() => new Promise(() => undefined));
    await show();
    const first = vi.mocked(coreJson).mock.calls[0]![1]!.signal!;
    expect(first.aborted).toBe(false);

    await show(app("off"));
    const next = vi.mocked(coreJson).mock.calls[1]![1]!.signal!;
    expect(first.aborted).toBe(true);
    expect(next.aborted).toBe(false);

    await act(async () => root.render(null));
    expect(next.aborted).toBe(true);
  });

  it("keeps the last figures when an answer doesn't come", async () => {
    vi.useFakeTimers();
    await show();
    vi.mocked(coreJson).mockRejectedValueOnce(new Error("No answer"));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(row("Memory")?.textContent).toMatch(/64 MB$/);
  });

  it("says its restarts in red only once it has stopped", async () => {
    const last = { at: new Date().toISOString(), failure: "hung" as const };
    running = { ...figures, restarts: { recent: 5, last } };

    await show(app("restarting"));
    const line = () => row("Restarts")!.querySelectorAll("span")[3]!;
    expect(line().className).not.toContain("text-destructive");

    await show(app("failed"));
    expect(line().className).toContain("text-destructive");
    expect(row("Restarts")?.textContent).toContain("5 in 10 minutes");
  });

  it("names its last update while it can go back", async () => {
    const lastUpdate = {
      id: "update-1",
      version: "0.2.0",
      since: "2026-11-02T10:00:00.000Z",
    };
    await show(app("running"), lastUpdate);

    expect(row("Its last update")?.textContent).toBe(
      "Its last updateFrom 0.2.0 on 2 November. Its data from before then is kept until its next update.",
    );

    await show(app("off"), lastUpdate);
    expect(row("Its last update")).toBeUndefined();
  });

  it("says nothing of an update it can't go back from", async () => {
    await show();

    expect(row("Its last update")).toBeUndefined();
  });
});

describe("the words for its figures", () => {
  it("says a processor's share plainly", () => {
    expect(processorWords(null)).toBe("—");
    expect(processorWords(0)).toBe("Under 1%");
    expect(processorWords(0.9)).toBe("Under 1%");
    expect(processorWords(1)).toBe("1%");
    expect(processorWords(49.6)).toBe("50%");
  });

  it("says what a restart touches until there's been one", () => {
    expect(restartsWords("Weather", { recent: 0 })).toEqual({
      figure: "None lately",
      line: "Only Weather restarts, never the rest of your home",
    });
  });

  it("says when the last was and what stopped it, in plain words", () => {
    const at = new Date().toISOString();

    expect(
      restartsWords("Weather", {
        recent: 3,
        last: { at, failure: "out_of_memory" },
      }),
    ).toEqual({
      figure: "3 in 10 minutes",
      line: `Last at ${clockTime(at)}: it ran out of memory`,
    });
  });

  it("names the day of one from before today", () => {
    vi.useFakeTimers({ now: new Date("2026-11-06T12:00:00.000Z") });
    const at = "2026-11-02T12:00:00.000Z";

    expect(
      restartsWords("Weather", { recent: 0, last: { at, failure: "crashed" } }),
    ).toEqual({
      figure: "None lately",
      line: `Last on 2 November at ${clockTime(at)}: it stopped after an error in its code`,
    });
  });
});

// @vitest-environment jsdom
import type { ActivityInfo, ActivityPage as Page } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  applyActivity,
  belongsTo,
  dayHeading,
  foldCauses,
} from "../src/activity/data";
import { ActivityPage, ActivitySection } from "../src/activity/page";
import { coreJson } from "../src/core-fetch";
import { alex, entry } from "./activity-fixtures";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

// The activity log in the client: the lists that follow it live, and the
// home's Activity. How each entry reads is in activity-words.test.ts.

describe("a live list", () => {
  const event = (id: string, device: string, minute: number) =>
    entry({
      id,
      at: new Date(Date.UTC(2026, 9, 31, 12, minute)).toISOString(),
      subject: { type: "device", id: device, name: device, gone: false },
    });

  it("reduces live device activity newest-first, target-only, and capped", () => {
    const belongs = belongsTo({ device: "desk-light" });
    const reduced = Array.from({ length: 205 }, (_, index) =>
      event(`event-${index}`, "desk-light", index),
    ).reduce(
      (current, each) => applyActivity(current, each, belongs),
      [] as ActivityInfo[],
    );

    expect(reduced).toHaveLength(200);
    expect(reduced[0]?.id).toBe("event-204");
    expect(reduced.at(-1)?.id).toBe("event-5");
    expect(
      applyActivity(reduced, event("other", "other", 999), belongs),
    ).toEqual(reduced);
  });

  it("keeps same-time entries in place when their details change", () => {
    const list = [event("command", "lamp", 1), event("run", "lamp", 1)];
    expect(
      applyActivity(list, { ...list[1]!, count: 2 }, belongsTo({})).map(
        (each) => each.id,
      ),
    ).toEqual(["command", "run"]);
  });

  it("puts an entry that changed in its new place", () => {
    const belongs = belongsTo({});
    const list = [event("b", "lamp", 2), event("a", "lamp", 1)];
    const joined = { ...event("a", "lamp", 3), count: 2 };
    expect(
      applyActivity(list, joined, belongs).map((each) => [each.id, each.count]),
    ).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
  });

  it("folds what a press or run led to under it, an app's own run left out", () => {
    const runInfo = (app: string | null) => ({
      entry: app ? "kept" : "run",
      workflow: app ? "kept" : "evening",
      name: app ? "Office button: double" : "Evening",
      app,
      trigger: { piece: "press", app: null },
    });
    const press = entry({ id: "press", action: "device.press" });
    const kept = entry({
      id: "kept",
      action: "workflow.run",
      causeId: "press",
      run: runInfo("sanctum.moods"),
    });
    const mood = entry({
      id: "mood",
      source: "sanctum.moods",
      action: "moods.runMood",
      causeId: "kept",
    });
    const lit = entry({
      id: "lit",
      causeId: "mood",
      run: runInfo("sanctum.moods"),
    });
    const run = entry({
      id: "run",
      action: "workflow.run",
      run: runInfo(null),
    });
    const step = entry({ id: "step", causeId: "run", run: runInfo(null) });
    const alone = entry({ id: "alone" });
    expect(
      foldCauses([lit, mood, kept, press, step, alone, run]).map((row) => [
        row.entry.id,
        row.under.map((each) => each.id),
      ]),
    ).toEqual([
      ["press", ["lit", "mood"]],
      ["alone", []],
      ["run", ["step"]],
    ]);
  });

  it("heads each day as people say it", () => {
    const now = Date.parse("2026-10-31T12:00:00");
    expect(dayHeading(Date.parse("2026-10-31T08:00:00"), now)).toBe("Today");
    expect(dayHeading(Date.parse("2026-10-30T23:00:00"), now)).toBe(
      "Yesterday",
    );
    expect(dayHeading(Date.parse("2026-10-29T10:00:00"), now)).toBe(
      "Thursday 29 October",
    );
  });
});

describe("the home's Activity", () => {
  let root: Root;
  let container: HTMLDivElement;
  let live: ReturnType<typeof createLiveFeed>;
  let pages: Record<string, Page>;
  let failing: boolean;
  // While set, activity requests wait for it.
  let held: Promise<void> | undefined;

  const asked = () =>
    vi
      .mocked(coreJson)
      .mock.calls.map(([path]) => path)
      .filter((path) => path.startsWith("/api/activity"));
  const button = (label: string) => {
    const found = [...container.querySelectorAll("button")].find(
      (each) =>
        each.getAttribute("aria-label") === label || each.textContent === label,
    );
    if (!found) throw new Error(`No button ${label}`);
    return found;
  };
  const click = (label: string) =>
    act(async () => {
      button(label).click();
    });

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    live = createLiveFeed();
    failing = false;
    held = undefined;
    const today = new Date().toISOString();
    const run = entry({
      id: "run",
      at: today,
      kind: "automations",
      source: "workflows",
      action: "workflow.run",
      who: { kind: "workflow", id: "evening", name: "Evening" },
      run: {
        entry: "run",
        workflow: "evening",
        name: "Evening",
        app: null,
        trigger: { piece: "sun", app: null, event: "sunset", offsetMinutes: 0 },
      },
      subject: {
        type: "workflow",
        id: "evening",
        name: "Evening",
        gone: false,
      },
      detail: { status: "succeeded" },
    });
    const lit = entry({
      id: "lit",
      at: today,
      who: run.who,
      run: run.run,
      causeId: "run",
    });
    pages = {
      all: {
        entries: [lit, run, entry({ id: "older", at: today })],
        more: true,
      },
      devices: { entries: [lit], more: false },
    };
    vi.mocked(coreJson).mockReset();
    vi.mocked(coreJson).mockImplementation(async (path: string) => {
      if (path === "/api/places" || path === "/api/devices") {
        return path === "/api/places"
          ? {
              home: { name: "Home", timeZone: "UTC" },
              floors: [],
              zones: [],
              rooms: [],
            }
          : [];
      }
      if (held && path.startsWith("/api/activity")) await held;
      if (failing && path.startsWith("/api/activity")) {
        failing = false;
        throw new Error("offline");
      }
      const query = new URL(path, "http://core").searchParams;
      if (query.get("before")) return { entries: [], more: false };
      return pages[query.get("kind") ?? "all"] ?? { entries: [], more: false };
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("shows the day's entries with a run's commands folded under it, then each kind", async () => {
    await act(async () => {
      root.render(
        <ActivityPage apps={[]} live={live} onDone={() => undefined} />,
      );
    });
    expect(asked()).toEqual(["/api/activity?limit=50"]);
    expect(container.textContent).toContain("Today");
    expect(container.textContent).toContain("Ran Evening");
    expect(container.textContent).toContain("At sunset");
    expect(container.textContent).not.toContain("Lamp turned on at 80%Evening");
    await click("Show what it did (1)");
    expect(container.textContent).toContain("Lamp turned on at 80%");

    await click("Show older");
    expect(asked().at(-1)).toBe("/api/activity?limit=50&before=older");
    expect(container.textContent).toContain(
      "That's the last 30 days of devices and automations",
    );

    await click("Devices");
    expect(asked().at(-1)).toBe("/api/activity?limit=50&kind=devices");
    expect(container.textContent).not.toContain("Ran Evening");
  });

  it("follows the live socket, and shows one device's until its token clears", async () => {
    await act(async () => {
      root.render(
        <ActivityPage
          device="lamp"
          apps={[]}
          live={live}
          onDone={() => undefined}
        />,
      );
    });
    expect(asked()).toEqual(["/api/activity?limit=50&device=lamp"]);
    await act(async () => {
      live.publish({
        type: "activity",
        entry: entry({
          id: "new",
          at: new Date().toISOString(),
          detail: { asked: { on: false } },
        }),
      });
      live.publish({
        type: "activity",
        entry: entry({
          id: "elsewhere",
          subject: {
            type: "device",
            id: "kettle",
            name: "Kettle",
            gone: false,
          },
        }),
      });
    });
    expect(container.textContent).toContain("Lamp turned off");
    expect(container.textContent).not.toContain("Kettle");

    await click("Show the whole home");
    expect(asked().at(-1)).toBe("/api/activity?limit=50");
  });

  it("can load older entries after changing filters during a request", async () => {
    let finish!: (page: Page) => void;
    await act(async () =>
      root.render(
        <ActivityPage apps={[]} live={live} onDone={() => undefined} />,
      ),
    );
    vi.mocked(coreJson).mockImplementationOnce(
      () =>
        new Promise<Page>((resolve) => {
          finish = resolve;
        }),
    );
    await click("Show older");
    pages.devices = { ...pages.devices!, more: true };
    await click("Devices");
    await act(async () => finish({ entries: [], more: false }));
    expect(button("Show older").disabled).toBe(false);
    await click("Show older");
    expect(asked().at(-1)).toBe(
      "/api/activity?limit=50&kind=devices&before=lit",
    );
  });

  it("preserves loaded pages on live updates and lets trimmed entries be fetched again", async () => {
    // One more than the 200 a live list keeps, the last page of one.
    const history = Array.from({ length: 201 }, (_, i) =>
      entry({
        id: `history-${i}`,
        at: new Date(Date.now() - (i + 1) * 1000).toISOString(),
        detail: { asked: { brightness: i } },
      }),
    );
    pages.all = { entries: history.slice(0, 50), more: true };
    await act(async () =>
      root.render(
        <ActivityPage apps={[]} live={live} onDone={() => undefined} />,
      ),
    );
    for (let start = 50; start < history.length; start += 50) {
      vi.mocked(coreJson).mockResolvedValueOnce({
        entries: history.slice(start, start + 50),
        more: start < 200,
      });
      await click("Show older");
    }
    const times = () => [...container.querySelectorAll("time")];
    expect(container.textContent).toContain("Lamp set to 0%");
    await act(async () =>
      live.publish({ type: "activity", entry: { ...history[0]!, count: 2 } }),
    );
    expect(times()).toHaveLength(201);
    // Its row shows the change, though the rows around it are not rendered again.
    expect(container.textContent).toContain("Lamp adjusted 2 times");
    expect(container.textContent).not.toContain("Lamp set to 0%");
    const at = new Date().toISOString();
    await act(async () =>
      live.publish({ type: "activity", entry: entry({ id: "new", at }) }),
    );
    expect(times()).toHaveLength(201);
    expect(times()[0]?.getAttribute("datetime")).toBe(at);
    expect(times()[0]?.closest("li")?.textContent).toContain(
      "Lamp turned on at 80%",
    );
    expect(times().at(-1)?.getAttribute("datetime")).toBe(history[199]!.at);
    expect(button("Show older").disabled).toBe(false);

    // The trimmed entry comes back from where the list now ends.
    vi.mocked(coreJson).mockResolvedValueOnce({
      entries: [history[200]!],
      more: false,
    });
    await click("Show older");
    expect(asked().at(-1)).toBe("/api/activity?limit=50&before=history-199");
    expect(times()).toHaveLength(202);
    expect(times().at(-1)?.getAttribute("datetime")).toBe(history[200]!.at);
  });

  it("keeps entries between pages when live updates arrive while older ones load", async () => {
    const history = Array.from({ length: 201 }, (_, i) =>
      entry({
        id: `history-${i}`,
        at: new Date(Date.now() - (i + 1) * 1000).toISOString(),
      }),
    );
    pages.all = { entries: history.slice(0, 50), more: true };
    await act(async () =>
      root.render(
        <ActivityPage apps={[]} live={live} onDone={() => undefined} />,
      ),
    );
    for (let start = 50; start < 200; start += 50) {
      vi.mocked(coreJson).mockResolvedValueOnce({
        entries: history.slice(start, start + 50),
        more: true,
      });
      await click("Show older");
    }
    let finish!: (page: Page) => void;
    vi.mocked(coreJson).mockImplementationOnce(
      () =>
        new Promise<Page>((resolve) => {
          finish = resolve;
        }),
    );
    await click("Show older");
    await act(async () =>
      live.publish({
        type: "activity",
        entry: entry({ id: "new", at: new Date().toISOString() }),
      }),
    );
    await act(async () => finish({ entries: history.slice(200), more: false }));
    expect(container.querySelectorAll("time")).toHaveLength(202);
  });

  it("offers older entries when the initial live buffer fills", async () => {
    let finish!: (page: Page) => void;
    const answer = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation((path, options) =>
      path.startsWith("/api/activity")
        ? new Promise<Page>((resolve) => {
            finish = resolve;
          })
        : answer(path, options),
    );
    await act(async () =>
      root.render(
        <ActivityPage apps={[]} live={live} onDone={() => undefined} />,
      ),
    );
    await act(async () => {
      for (let index = 0; index < 201; index++) {
        live.publish({
          type: "activity",
          entry: entry({
            id: `new-${index}`,
            at: new Date(Date.now() + index).toISOString(),
          }),
        });
      }
      finish({ entries: [], more: false });
    });
    expect(container.querySelectorAll("time")).toHaveLength(200);
    expect(button("Show older").disabled).toBe(false);
  });

  it("shows the newest few in Settings, and opens the rest", async () => {
    const onShowAll = vi.fn();
    await act(async () => {
      root.render(
        <ActivitySection apps={[]} live={live} onShowAll={onShowAll} />,
      );
    });
    expect(asked()).toEqual(["/api/activity?limit=5"]);
    expect(container.textContent).toContain("Who did what in the home");
    expect(container.textContent).toContain("Lamp turned on at 80%");
    await click("Show all");
    expect(onShowAll).toHaveBeenCalled();
    expect(alex.name).toBe("Alex");
  });

  it("keeps what it shows on a live refresh until the first page comes again", async () => {
    await act(async () => {
      root.render(
        <ActivityPage apps={[]} live={live} onDone={() => undefined} />,
      );
    });
    let release!: () => void;
    held = new Promise((resolve) => (release = resolve));
    pages.all = {
      entries: [entry({ id: "fresh", at: new Date().toISOString() })],
      more: false,
    };
    await act(async () => live.refresh());
    expect(container.textContent).toContain("Ran Evening");
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();

    await act(async () => release());
    expect(container.textContent).not.toContain("Ran Evening");
    expect(container.textContent).toContain("Lamp turned on at 80%");
  });

  it("says when it didn't load, and tries again", async () => {
    failing = true;
    await act(async () => {
      root.render(
        <ActivityPage apps={[]} live={live} onDone={() => undefined} />,
      );
    });
    expect(container.textContent).toContain("Activity didn't load");
    await click("Try again");
    expect(container.textContent).toContain("Ran Evening");
  });
});

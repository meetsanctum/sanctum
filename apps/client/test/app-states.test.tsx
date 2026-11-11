// @vitest-environment jsdom
import type { AppInfo, AppRun, AppState } from "@meetsanctum/app-sdk";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AppNotice,
  looksRunning,
  restartingWords,
  stateShort,
  waitingWords,
  WhileNotRunning,
} from "../src/app-state";
import {
  appAttentionSpoken,
  appAttentionText,
  appsNotRunning,
  attentionTile,
} from "../src/attention";
import {
  blockedBy,
  blockedLine,
  blockedWords,
} from "../src/automations/blocked";
import { productName } from "../src/brand";
import { coreJson } from "../src/core-fetch";

// An app's states from its supervisor, said the same everywhere it shows.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const app = (state: AppState, run?: AppRun): AppInfo =>
  ({
    id: "test.weather",
    name: "Weather",
    version: "0.3.0",
    icon: null,
    pages: [],
    permissions: [],
    requests: [],
    state,
    ...(run ? { run } : {}),
    settings: null,
    provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
  }) as AppInfo;

const since = "2026-11-05T14:02:00.000Z";
const failed = app("failed", {
  since,
  failures: 5,
  lastFailure: "out_of_memory",
});
const waiting = app("waiting", {
  since,
  waitingFor: "Waiting for the internet",
});
const restarting = app("restarting", {
  since,
  failures: 3,
  lastFailure: "crashed",
});

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(coreJson).mockReset();
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const show = (ui: ReactNode) => act(async () => root.render(ui));

const notice = (
  shown: AppInfo,
  permissionsAre: "below" | "settings" = "settings",
) =>
  show(
    <AppNotice
      app={shown}
      permissionsAre={permissionsAre}
      openStatus={() => undefined}
      openSettings={() => undefined}
    />,
  );

const status = () => host.querySelector('[role="status"]');
const button = (name: string) =>
  [...host.querySelectorAll("button")].find(
    (each) =>
      each.getAttribute("aria-label") === name || each.textContent === name,
  );

describe("what an app's states look like", () => {
  it("goes on as it was while it's running, or only just went down", () => {
    expect(looksRunning(app("running"))).toBe(true);
    expect(looksRunning(app("restarting", { since, quiet: true }))).toBe(true);
    expect(looksRunning(app("waiting", { since, quiet: true }))).toBe(true);
    expect(stateShort(app("restarting", { since, quiet: true }))).toBeNull();
  });

  it("goes on as it was on its first way up, which nothing has interrupted", () => {
    expect(looksRunning(app("starting", { since, isFirstStart: true }))).toBe(
      true,
    );
    expect(
      stateShort(app("starting", { since, isFirstStart: true })),
    ).toBeNull();
  });

  it("says Not running once it has been down a while", () => {
    expect(stateShort(restarting)).toBe("Not running");
    expect(stateShort(waiting)).toBe("Not running");
    expect(stateShort(failed)).toBe("Not running");
    expect(stateShort(app("starting", { since, failures: 1 }))).toBe(
      "Not running",
    );
  });

  it("keeps Paused for one that's paused", () => {
    expect(stateShort(app("paused"))).toBe("Paused");
  });

  it("shows a permission pause even during the supervisor's quiet period", async () => {
    const paused = app("paused", { since, quiet: true });
    expect(stateShort(paused)).toBe("Paused");
    expect(appsNotRunning([paused])).toEqual([paused]);

    await notice(paused);
    expect(status()?.textContent).toContain("Weather is paused");

    await show(
      <WhileNotRunning app={paused} className="page">
        <button>Press</button>
      </WhileNotRunning>,
    );
    expect(host.firstElementChild?.hasAttribute("inert")).toBe(true);
  });

  it("keeps a manual restart visible after its failure count is cleared", async () => {
    const starting = app("starting", { since, lastFailure: "out_of_memory" });
    expect(stateShort(starting)).toBe("Not running");

    await notice(starting);
    expect(status()?.textContent).toContain("Weather is restarting");
    expect(status()?.textContent).toContain("It ran out of memory");
  });

  it("shows a resumed start once its quiet period ends, even without any failures", async () => {
    const starting = app("starting", { since });
    expect(stateShort(starting)).toBe("Not running");

    await notice(starting);
    expect(status()?.textContent).toContain("Weather is starting");
    expect(status()?.textContent).toContain("It starts again by itself.");
  });

  it("dims and locks its page only once that shows", async () => {
    await show(
      <WhileNotRunning
        app={app("restarting", { since, quiet: true })}
        className="page"
      >
        <button>Press</button>
      </WhileNotRunning>,
    );
    expect(host.firstElementChild?.className).toBe("page");
    expect(host.firstElementChild?.hasAttribute("inert")).toBe(false);

    await show(
      <WhileNotRunning app={restarting} className="page">
        <button>Press</button>
      </WhileNotRunning>,
    );

    expect(host.firstElementChild?.className).toContain("opacity-50");
    expect(host.firstElementChild?.hasAttribute("inert")).toBe(true);
  });
});

describe("its words", () => {
  it("counts its restarts from the second", () => {
    expect(restartingWords(app("restarting", { since, failures: 1 }))).toBe(
      "Restarting",
    );
    expect(restartingWords(app("restarting", { since, failures: 2 }))).toBe(
      "Restarting · second time in 10 minutes",
    );
    expect(restartingWords(restarting)).toBe(
      "Restarting · third time in 10 minutes",
    );
    expect(restartingWords(app("restarting", { since, failures: 4 }))).toBe(
      "Restarting · fourth time in 10 minutes",
    );
  });

  it("says what it waits for, in its words, or for Sanctum itself", () => {
    expect(waitingWords(waiting)).toBe("Waiting for the internet");
    expect(waitingWords(app("waiting", { since }))).toBe(
      `Waiting for ${productName}`,
    );
  });
});

describe("its notice", () => {
  it("doesn't show on its pages while it goes on as it was", async () => {
    await notice(app("restarting", { since, quiet: true, failures: 1 }));

    expect(status()).toBeNull();
  });

  it("shows at once on its settings page, where people go to look", async () => {
    await notice(
      app("restarting", {
        since,
        quiet: true,
        failures: 1,
        lastFailure: "hung",
      }),
      "below",
    );

    expect(status()?.textContent).toContain("Weather is restarting");
    expect(status()?.textContent).toContain(
      "It stopped answering, and it starts again by itself.",
    );
  });

  it("has nothing to say of one on its first way up, even in its settings", async () => {
    await notice(app("starting", { since, isFirstStart: true }), "below");

    expect(status()).toBeNull();
  });

  it("says what it waits for, and that it starts by itself", async () => {
    await notice(waiting);

    expect(status()?.textContent).toContain(
      "Weather is waiting for the internet",
    );
    expect(status()?.textContent).toContain("It starts by itself once it can.");
    expect(button("Restart Weather")).toBeUndefined();
  });

  it.each([
    ["crashed", "the last time, it stopped after an error in its code."],
    ["out_of_memory", "the last time, it ran out of memory."],
    ["hung", "the last time, it stopped answering."],
    ["failed_start", "the last time, it didn't start."],
  ] as const)(
    "says what stopped it for good: %s",
    async (lastFailure, words) => {
      await notice(app("failed", { since, failures: 5, lastFailure }));

      expect(status()?.textContent).toContain("Weather isn't running");
      expect(status()?.textContent?.toLowerCase()).toContain(words);
    },
  );

  it("restarts it from there", async () => {
    vi.mocked(coreJson).mockResolvedValue(app("starting", { since }));
    await notice(failed);

    await act(async () => button("Restart Weather")!.click());

    expect(coreJson).toHaveBeenCalledWith("/api/apps/test.weather/restart", {
      method: "POST",
      json: {},
    });
    expect(button("Restart Weather")?.textContent).toBe("Restart");
  });

  it("offers to try again when that fails", async () => {
    vi.mocked(coreJson).mockRejectedValue(new Error("No"));
    await notice(failed);

    await act(async () => button("Restart Weather")!.click());

    expect(button("Try again to restart Weather")?.textContent).toBe(
      "Try again",
    );
  });

  it("keeps Open Status for one that didn't stop cleanly, in the core's process", async () => {
    await notice(app("stopped"));

    expect(button("Open Status")).toBeDefined();
    expect(button("Restart Weather")).toBeUndefined();
  });
});

describe("Needs attention", () => {
  it("leaves out one on its way back, or waiting only a little", () => {
    expect(
      appsNotRunning([
        app("running"),
        app("starting", { since }),
        restarting,
        waiting,
        app("restarting", { since, quiet: true }),
      ]),
    ).toEqual([]);
  });

  it("lists one that has waited a while, plainly, and one stopped first", () => {
    const longer = app("waiting", {
      since,
      waitingFor: "Waiting for Zigbee2MQTT",
      attention: true,
    });

    expect(
      appsNotRunning([
        { ...longer, name: "Zigbee" },
        { ...failed, name: "Weather" },
      ]).map(({ name }) => name),
    ).toEqual(["Weather", "Zigbee"]);
    expect(appAttentionText(longer)).toMatch(
      /^Waiting for Zigbee2MQTT since .+\. It starts by itself once it can$/,
    );
    expect(appAttentionSpoken(longer)).toBe("Weather is waiting");
    expect(attentionTile([], [], "celsius", [longer])?.problem).toBe(false);
  });

  it("says one stopped for good is a problem", () => {
    expect(appAttentionText(failed)).toBe(
      "Not running: stopped after 5 failures in 10 minutes",
    );
    expect(appAttentionSpoken(failed)).toBe("Weather isn't running");
    expect(attentionTile([], [], "celsius", [failed])).toMatchObject({
      title: "Weather",
      value: "Not running",
      problem: true,
    });
  });
});

describe("automations that use it", () => {
  const workflow = {
    app: "test.weather",
    graph: { nodes: [] },
    suspended: [],
  } as unknown as Parameters<typeof blockedBy>[0];

  it("doesn't call one blocked by a restart nobody would notice", () => {
    expect(
      blockedBy(workflow, [app("restarting", { since, quiet: true })]),
    ).toBeNull();
  });

  it("keeps an automation blocked by a permission pause during the quiet period", () => {
    const paused = app("paused", { since, quiet: true });
    expect(blockedBy(workflow, [paused])).toEqual({
      app: paused,
      kind: "paused",
    });
  });

  it("says it can't run while the app is on its way back, and that it will", () => {
    const blocked = blockedBy(workflow, [restarting])!;

    expect(blockedLine(blocked)).toBe("Can't run while Weather isn't running");
    expect(blockedWords(blocked).detail).toBe(
      "Weather starts again by itself, and this can run once it has.",
    );
  });

  it("says where to restart one given up on", () => {
    const blocked = blockedBy(workflow, [failed])!;

    expect(blockedLine(blocked)).toBe("Can't run while Weather isn't running");
    expect(blockedWords(blocked).detail).toBe(
      "Weather stopped after 5 failures in 10 minutes. Restart it in Weather settings.",
    );
  });
});

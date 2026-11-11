// @vitest-environment jsdom
import type { AppInfo, AppRun, AppState } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AppNotice, looksRunning, wentBackWords } from "../src/app-state";
import {
  appAttentionSpoken,
  appAttentionText,
  appsNotRunning,
  attentionTile,
} from "../src/attention";

// What clients say of an app's update: that it's updating, that it's going
// back, and that it went back.

const since = "2026-11-05T14:02:00.000Z";
const app = (state: AppState, update: AppRun["update"]): AppInfo =>
  ({
    id: "test.weather",
    name: "Weather",
    version: "0.3.0",
    icon: null,
    pages: [],
    permissions: [],
    requests: [],
    state,
    run: { since, update },
    settings: null,
    provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
  }) as AppInfo;

const updating = app("starting", { stage: "updating", to: "0.4.0" });
const goingBack = app("starting", { stage: "goingBack", to: "0.3.0" });
const wentBack = app("running", {
  stage: "wentBack",
  from: "0.4.0",
  triesAgain: false,
});
const notReady = app("running", {
  stage: "wentBack",
  from: "0.4.0",
  triesAgain: true,
});

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

const notice = (
  shown: AppInfo,
  permissionsAre: "below" | "settings" = "below",
) =>
  act(async () =>
    root.render(
      <AppNotice
        app={shown}
        permissionsAre={permissionsAre}
        openStatus={() => undefined}
        openSettings={() => undefined}
      />,
    ),
  );

describe("its notice", () => {
  it("shows a slow update above its pages after the quiet period", async () => {
    const slow = {
      ...updating,
      run: { ...updating.run!, isFirstStart: true as const },
    };
    expect(looksRunning(slow)).toBe(false);
    await notice(slow, "settings");
    expect(host.textContent).toContain("Weather is updating to 0.4.0");
  });

  it("keeps an update quiet for the first thirty seconds", async () => {
    const quiet = {
      ...updating,
      run: { ...updating.run!, quiet: true as const },
    };
    expect(looksRunning(quiet)).toBe(true);
    await notice(quiet, "settings");
    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it("keeps an ordinary first start quiet after a previous rollback", () => {
    const starting = {
      ...wentBack,
      state: "starting" as const,
      run: { ...wentBack.run!, isFirstStart: true as const },
    };
    expect(looksRunning(starting)).toBe(true);
  });

  it.each(["updating", "goingBack"] as const)(
    "says an app is off even during %s",
    async (stage) => {
      await notice(app("off", { stage, to: "0.4.0" }));
      expect(host.textContent).toContain("Weather is off");
      expect(host.textContent).not.toContain("is updating");
      expect(host.textContent).not.toContain("is going back");
    },
  );

  it("says what it's updating to, and that it starts by itself", async () => {
    await notice(updating);

    expect(host.textContent).toContain("Weather is updating to 0.4.0");
    expect(host.textContent).toContain("It starts by itself once it has.");
  });

  it("says it's updating though it's waiting for its turn", async () => {
    await notice(app("waiting", { stage: "updating", to: "0.4.0" }));

    expect(host.textContent).toContain("Weather is updating to 0.4.0");
    expect(host.textContent).not.toContain("is waiting");
  });

  it("says it's going back, until its data is", async () => {
    await notice(goingBack);

    expect(host.textContent).toContain("Weather is going back to 0.3.0");
    expect(host.textContent).toContain("once its data is back");
  });

  it("says on its settings that a version didn't start, and won't be tried again", async () => {
    await notice(wentBack);

    expect(host.textContent).toContain(
      "Version 0.4.0 didn't start, so it's back on 0.3.0",
    );
    expect(host.textContent).toContain(
      "It isn't tried again until a newer version arrives.",
    );
  });

  it("says one that wasn't ready tries again", async () => {
    await notice(notReady);

    expect(host.textContent).toContain(
      "Version 0.4.0 wasn't ready, so it's back on 0.3.0",
    );
    expect(host.textContent).toContain("It tries again later.");
  });

  it("keeps quiet above its own pages, since it runs as usual", async () => {
    await notice(wentBack, "settings");

    expect(host.querySelector('[role="status"]')).toBeNull();
  });

  it("says why it stopped rather than what it went back from, if it fails after", async () => {
    await notice({
      ...app("failed", { stage: "wentBack", from: "0.4.0", triesAgain: false }),
    });

    expect(host.textContent).toContain("Weather isn't running");
  });
});

describe("Needs attention", () => {
  it("says the app went back on Home while it continues running", () => {
    expect(attentionTile([], [], "celsius", [wentBack])).toMatchObject({
      title: "Weather",
      value: "Back on 0.3.0",
      problem: false,
    });
  });
  it("lists one back on its old version, plainly, since it runs", () => {
    expect(appsNotRunning([wentBack])).toEqual([wentBack]);
    expect(appAttentionText(wentBack)).toBe(
      "Version 0.4.0 didn't start, so it's back on 0.3.0",
    );
    expect(appAttentionSpoken(wentBack)).toBe("Weather went back to 0.3.0");
  });

  it("doesn't list one that tries again by itself", () => {
    expect(appsNotRunning([notReady])).toEqual([]);
  });

  it("doesn't list one on its way through an update", () => {
    expect(appsNotRunning([updating, goingBack])).toEqual([]);
  });
});

describe("its words", () => {
  it("say which version and which it's on", () => {
    expect(
      wentBackWords(wentBack, {
        stage: "wentBack",
        from: "0.4.0",
        triesAgain: false,
      }),
    ).toBe("Version 0.4.0 didn't start, so it's back on 0.3.0");
  });
});

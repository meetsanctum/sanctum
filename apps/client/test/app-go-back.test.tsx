// @vitest-environment jsdom
import type { AppInfo, AppRun, AppState } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activityWords } from "../src/activity/words";
import { GoBack, goingBackWords, useGoBackTo } from "../src/app-go-back";
import { AppNotice, wentBackWords } from "../src/app-state";
import { appsNotRunning } from "../src/attention";
import { CoreError, coreJson } from "../src/core-fetch";
import { entry } from "./activity-fixtures";

// Going back from an app's last update: when its settings offer it, what
// they ask first, and what it says afterwards.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const app = (state: AppState = "running", update?: AppRun["update"]) =>
  ({
    id: "test.moods",
    name: "Moods",
    version: "0.9.0",
    icon: null,
    pages: [],
    permissions: [],
    requests: [],
    state,
    run: { since: "2026-11-05T14:02:00.000Z", update },
    settings: null,
    provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
  }) as AppInfo;

const to = {
  id: "update-1",
  version: "0.8.0",
  since: "2026-11-02T10:00:00.000Z",
};
const path = "/api/apps/test.moods/go-back";

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (_path, init) =>
    init?.method === "POST" ? {} : { to },
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function Shown(props: { app: AppInfo }) {
  return <GoBack app={props.app} to={useGoBackTo(props.app)} />;
}

const show = (shown: AppInfo) =>
  act(async () => root.render(<Shown app={shown} />));

const button = (name: string) =>
  [...document.body.querySelectorAll("button")].find(
    ({ textContent }) => textContent === name,
  );

const press = (name: string) =>
  act(async () => {
    button(name)!.click();
  });

describe("when it's offered", () => {
  it("offers the version before its last update", async () => {
    await show(app());

    expect(coreJson).toHaveBeenCalledWith(path);
    expect(button("Go back to 0.8.0")).toBeDefined();
  });

  it("offers nothing when the home has nothing to go back to", async () => {
    vi.mocked(coreJson).mockResolvedValue({ to: null });

    await show(app());

    expect(host.textContent).toBe("");
  });

  it("offers nothing when the home can't say", async () => {
    vi.mocked(coreJson).mockRejectedValue(new CoreError(503, "unavailable"));

    await show(app());

    expect(host.textContent).toBe("");
  });

  it.each(["running", "waiting", "restarting", "failed"] as const)(
    "is there while it's %s",
    async (state) => {
      await show(app(state));

      expect(button("Go back to 0.8.0")).toBeDefined();
    },
  );

  it.each(["off", "paused", "starting"] as const)(
    "isn't there while it's %s",
    async (state) => {
      await show(app(state));

      expect(host.textContent).toBe("");
    },
  );

  it.each(["updating", "goingBack"] as const)(
    "isn't there during %s",
    async (stage) => {
      await show(app("running", { stage, to: "0.8.0" }));

      expect(host.textContent).toBe("");
    },
  );

  it("asks again once its version changes", async () => {
    await show(app());
    vi.mocked(coreJson).mockResolvedValue({ to: null });

    await show({ ...app(), version: "0.8.0" });

    expect(host.textContent).toBe("");
  });

  it("asks again after an app that was off starts running", async () => {
    vi.mocked(coreJson).mockResolvedValueOnce({ to: null });
    await show(app("off"));
    expect(host.textContent).toBe("");

    await show(app("running"));

    expect(button("Go back to 0.8.0")).toBeDefined();
  });
});

describe("what it asks", () => {
  it("says what's lost, what stays and how long it lasts, with Cancel focused", async () => {
    await show(app());

    await press("Go back to 0.8.0");

    expect(document.body.textContent).toContain("Go back to Moods 0.8.0?");
    expect(document.body.textContent).toContain(goingBackWords(app(), to));
    expect(goingBackWords(app(), to)).toBe(
      "Its data returns to how it was before the update on 2 November, so anything it has saved since is lost, and automations that use it may need changing. Settings you've chosen stay where 0.8.0 can use them. It stays on 0.8.0 until a version newer than 0.9.0 arrives.",
    );
    expect(document.activeElement).toBe(button("Cancel"));
  });

  it("does nothing on Cancel", async () => {
    await show(app());
    await press("Go back to 0.8.0");

    await press("Cancel");

    expect(coreJson).not.toHaveBeenCalledWith(
      path,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("goes back once asked", async () => {
    await show(app());
    await press("Go back to 0.8.0");

    await press("Go back");

    expect(coreJson).toHaveBeenCalledWith(path, {
      method: "POST",
      json: { id: to.id },
    });
  });

  it("says so if it couldn't", async () => {
    await show(app());
    vi.mocked(coreJson).mockRejectedValue(new CoreError(409, "conflict"));
    await press("Go back to 0.8.0");

    await press("Go back");

    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "Moods couldn't go back. Try again.",
    );
  });
});

describe("afterwards", () => {
  const chose = {
    ...app("running", {
      stage: "wentBack",
      from: "0.9.0",
      triesAgain: false,
      chosen: true,
    }),
    version: "0.8.0",
  };

  const notice = (shown: AppInfo) =>
    act(async () =>
      root.render(
        <AppNotice
          app={shown}
          permissionsAre="below"
          openStatus={() => undefined}
        />,
      ),
    );

  it("says it went back at someone's asking, in its settings", async () => {
    await notice(chose);

    expect(host.textContent).toContain("Went back to 0.8.0 from 0.9.0");
    expect(host.textContent).toContain(
      "It stays on 0.8.0 until a newer version arrives.",
    );
  });

  it("isn't something that needs attention", () => {
    expect(appsNotRunning([chose])).toEqual([]);
  });

  it("does need attention if it failed and returned", () => {
    const failed = app("running", {
      stage: "wentBack",
      from: "0.8.0",
      triesAgain: false,
    });

    expect(appsNotRunning([failed])).toEqual([failed]);
    expect(
      wentBackWords(failed, {
        stage: "wentBack",
        from: "0.8.0",
        triesAgain: false,
      }),
    ).toBe("Version 0.8.0 didn't start, so it's back on 0.9.0");
  });

  it("says so going back, even before it has stopped", async () => {
    await notice(app("running", { stage: "goingBack", to: "0.8.0" }));

    expect(host.textContent).toContain("Moods is going back to 0.8.0");
  });

  it.each([
    ["ok", "Went back to the app's version before"],
    ["refused", "Couldn't go back to the app's version before"],
  ] as const)("goes in the activity log (%s)", (outcome, title) => {
    const words = activityWords(entry({ action: "go-back", outcome }), "home");
    expect(words.title).toBe(title);
  });
});

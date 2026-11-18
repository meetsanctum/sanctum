// @vitest-environment jsdom
import type { AppInfo, AppWaitingUpdate } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activityWords } from "../src/activity/words";
import {
  UpdateWaiting,
  waitingAttentionText,
  waitingNoticeWords,
} from "../src/app-update-waiting";
import {
  appAttentionText,
  appsNotRunning,
  attentionTile,
  isStopped,
} from "../src/attention";
import { productName } from "../src/brand";
import { CoreError, coreJson } from "../src/core-fetch";
import { entry } from "./activity-fixtures";

// A newer version that waits for someone to allow what it newly needs: what
// its settings and Needs attention say, what Review asks, and what allowing
// sends.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const waiting: AppWaitingUpdate = {
  id: "waiting-1",
  version: "0.11.0",
  build: "0.11.0+waiting",
  needs: [
    {
      id: "people.read",
      reason: "To start a mood when someone comes home.",
      needed: true,
      asked: null,
      startsOn: false,
    },
  ],
};

const app = (
  version = "0.10.0",
  state: AppInfo["state"] = "running",
): AppInfo => ({
  id: "test.moods",
  name: "Moods",
  version,
  // On the build that waits when it's paused for it, or turned off there.
  build:
    state === "paused" || state === "off"
      ? waiting.build
      : `${version}+running`,
  icon: null,
  pages: [],
  permissions: [],
  requests: [],
  state,
  run: { since: "2026-11-05T14:02:00.000Z" },
  waiting,
  settings: null,
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
});

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockResolvedValue({});
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

const show = (shown: AppInfo) =>
  act(async () => root.render(<UpdateWaiting app={shown} />));

const button = (name: string) =>
  [...document.body.querySelectorAll("button")].find(
    ({ textContent }) => textContent === name,
  );

const press = (name: string) =>
  act(async () => {
    button(name)!.click();
  });

const dialog = () => document.body.querySelector('[role="dialog"]');

describe("an update that waits", () => {
  it("says which version waits, what it needs, and that the app stays on its own", () => {
    expect(waitingNoticeWords(app(), waiting)).toEqual({
      title: "Moods 0.11.0 is waiting",
      line: "It needs to see who lives here. Moods stays on 0.10.0 until someone allows it.",
    });
  });

  it("says the app can't run when it's stopped on the version that waits", () => {
    expect(waitingNoticeWords(app("0.11.0", "paused"), waiting)).toEqual({
      title: `Moods can't run on this ${productName}`,
      line: "Allow 0.11.0 to start it again. It needs to see who lives here.",
    });
  });

  it("keeps a running build plain when the waiting build has the same version", () => {
    const running = app("0.11.0");

    expect(waitingNoticeWords(running, waiting).title).toBe(
      "Moods 0.11.0 is waiting",
    );
    expect(isStopped(running)).toBe(false);
    expect(attentionTile([], [], "celsius", [running])).toMatchObject({
      value: "0.11.0 waits",
      problem: false,
    });
  });

  it("doesn't say allowing starts one someone turned off", () => {
    expect(waitingNoticeWords(app("0.11.0", "off"), waiting).line).toBe(
      "Allow 0.11.0 so it can run. It needs to see who lives here.",
    );
  });

  it("shows only what's new on Review, with Not now focused", async () => {
    await show(app());
    await press("Review");

    expect(dialog()!.textContent).toContain("Update Moods to 0.11.0?");
    expect(dialog()!.textContent).toContain(
      "To start a mood when someone comes home.",
    );
    expect(document.activeElement?.textContent).toBe("Not now");
    expect(coreJson).not.toHaveBeenCalled();
  });

  it("changes nothing on Not now", async () => {
    await show(app());
    await press("Review");
    await press("Not now");

    expect(dialog()).toBeNull();
    expect(coreJson).not.toHaveBeenCalled();
    // Radix gives focus back once the dialog has gone.
    await vi.waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Review"),
    );
  });

  it("allows the version it showed on Update", async () => {
    await show(app());
    await press("Review");
    await press("Update");

    expect(coreJson).toHaveBeenCalledWith("/api/apps/test.moods/update/allow", {
      method: "POST",
      json: { id: "waiting-1" },
    });
    expect(dialog()).toBeNull();
  });

  it("says when another version took its place meanwhile", async () => {
    vi.mocked(coreJson).mockRejectedValue(new CoreError(409, "conflict"));
    await show(app());
    await press("Review");
    await press("Update");

    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toBe(
      "Moods changed meanwhile, as when it was allowed on another device. Close this and look again.",
    );
  });

  it("asks to start one stopped for it, with Allow", async () => {
    await show(app("0.11.0", "paused"));
    await press("Review");

    expect(dialog()!.textContent).toContain("Start Moods 0.11.0?");
    expect(button("Allow")).toBeDefined();
  });
});

describe("an update that waits for room", () => {
  const forRoom: AppWaitingUpdate = {
    ...waiting,
    needs: [],
    moreMemoryMb: 64,
  };

  it("says how much more memory it needs and what makes room", () => {
    expect(waitingNoticeWords(app(), forRoom)).toEqual({
      title: "Moods 0.11.0 is waiting",
      line: "It needs 64 MB more memory. Turning off an app you don't use makes room.",
    });
    expect(waitingAttentionText(app(), forRoom)).toBe(
      "0.11.0 is waiting: it needs 64 MB more memory",
    );
  });

  it("offers nothing to review, since nothing waits for an answer", async () => {
    await show({ ...app(), waiting: forRoom });

    expect(host.textContent).toContain("It needs 64 MB more memory.");
    expect(button("Review")).toBeUndefined();
  });
});

describe("in Needs attention", () => {
  it("lists one that waits plainly, though it runs", () => {
    const waits = app();
    expect(appsNotRunning([waits])).toEqual([waits]);
    expect(isStopped(waits)).toBe(false);
    expect(appAttentionText(waits)).toBe(waitingAttentionText(waits, waiting));
    expect(appAttentionText(waits)).toBe(
      "0.11.0 is waiting: it needs to see who lives here",
    );
    expect(attentionTile([], [], "celsius", [waits])).toMatchObject({
      title: "Moods",
      value: "0.11.0 waits",
      problem: false,
    });
  });

  it("lists one stopped for it as a problem", () => {
    const stopped = app("0.11.0", "paused");
    expect(isStopped(stopped)).toBe(true);
    expect(appAttentionText(stopped)).toBe(
      `Can't run on this ${productName}: allow 0.11.0 to start it again`,
    );
  });

  it("says first that the version it has stopped, with Restart", async () => {
    const failed = app("0.10.0", "failed");
    expect(appAttentionText(failed)).not.toContain("0.11.0");
    expect(isStopped(failed)).toBe(true);
  });

  it.each([
    ["ok", "Allowed the app's new version"],
    ["refused", "Couldn't allow the app's new version"],
  ] as const)("goes in the activity log (%s)", (outcome, title) => {
    const words = activityWords(
      entry({ action: "allow-update", outcome }),
      "home",
    );
    expect(words.title).toBe(title);
  });
});

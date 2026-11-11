// @vitest-environment jsdom
import type { AppInfo } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson, CoreError } from "../src/core-fetch";
import { usePermissionSheet } from "../src/permission-sheet";

// The shell's sheet that asks for an app's optional permissions: each in
// Sanctum's words with the app's reason, Allow through the grant route, Not
// now changing nothing, and one sheet at a time.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const request = (id: string, reason: string) => ({
  id,
  reason,
  needed: false,
  asked: null,
  startsOn: false,
});
const moods: AppInfo = {
  id: "sanctum.moods",
  name: "Moods",
  version: "0.9.0",
  icon: { glyph: "sparkles", color: "ember" },
  pages: ["room"],
  permissions: ["places.read"],
  requests: [
    { ...request("places.read", "To keep moods."), needed: true },
    request(
      "devices.read:button",
      "So a press of a remote can run the mood you chose.",
    ),
    request(
      "devices.read:occupancy",
      "To turn a room's lights on when someone comes in.",
    ),
    request(
      "workflows.manage",
      "So presses and motion run what you chose for them.",
    ),
  ],
  state: "running",
  settings: null,
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
};

let root: Root;
let container: HTMLDivElement;
let app: AppInfo;
let ask: (app: string, permissions: readonly string[]) => Promise<boolean>;
const changed: AppInfo[] = [];

function Harness() {
  const sheet = usePermissionSheet([app], (next) => {
    changed.push(next);
    app = next;
  });
  ask = sheet.ask;
  return sheet.sheet;
}

const render = () => act(async () => root.render(<Harness />));
const dialog = () => document.querySelector('[role="dialog"]');
const press = async (name: string) => {
  const button = [
    ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
  ].find((each) => each.textContent === name)!;
  await act(async () => button.click());
  await render();
};
const granted = () =>
  vi
    .mocked(coreJson)
    .mock.calls.filter(([path]) => path.endsWith("/permissions/update"))
    .map(([, init]) => init?.json);

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  app = moods;
  changed.length = 0;
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (_path, init) => {
    const { permission } = init!.json as { permission: string };
    return { ...app, permissions: [...app.permissions, permission] };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await render();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("the sheet that asks for a permission", () => {
  it("asks for one in Sanctum's words, with the app's reason, and Allow turns it on", async () => {
    let answer: boolean | undefined;
    await act(async () => {
      void ask("sanctum.moods", ["devices.read:occupancy"]).then(
        (granted) => (answer = granted),
      );
    });

    expect(dialog()?.querySelector("h2")?.textContent).toBe(
      "Allow Moods to know when there's motion?",
    );
    expect(dialog()?.textContent).toContain(
      "To turn a room's lights on when someone comes in.",
    );
    expect(dialog()?.textContent).toContain(
      "You can switch it off again in Moods settings.",
    );

    await press("Allow");
    expect(granted()).toEqual([
      { permission: "devices.read:occupancy", granted: true },
    ]);
    // The shell takes the core's answer for everything that shows Moods.
    expect(changed.at(-1)?.permissions).toContain("devices.read:occupancy");
    expect(answer).toBe(true);
    expect(dialog()).toBeNull();
  });

  it("asks for several in one sheet, and Not now changes nothing", async () => {
    let answer: boolean | undefined;
    await act(async () => {
      void ask("sanctum.moods", [
        "devices.read:button",
        "workflows.manage",
      ]).then((granted) => (answer = granted));
    });

    expect(dialog()?.querySelector("h2")?.textContent).toBe(
      "Allow Moods to see your remotes' presses and keep its own automations?",
    );
    expect(
      [...dialog()!.querySelectorAll("li")].map((each) => each.textContent),
    ).toEqual([
      "See your remotes' pressesSo a press of a remote can run the mood you chose.",
      "Keep its own automationsSo presses and motion run what you chose for them.",
    ]);
    expect(dialog()?.textContent).toContain(
      "You can switch them off again in Moods settings.",
    );

    await press("Not now");
    expect(answer).toBe(false);
    expect(granted()).toEqual([]);
    expect(dialog()).toBeNull();
  });

  it("says what went wrong when Allow fails, and asks only for what is still off when tried again", async () => {
    vi.mocked(coreJson).mockImplementation(async (_path, init) => {
      const { permission } = init!.json as { permission: string };
      if (permission === "workflows.manage" && granted().length === 2) {
        throw new CoreError(409, "conflict", null);
      }
      return { ...app, permissions: [...app.permissions, permission] };
    });
    let answer: boolean | undefined;
    await act(async () => {
      void ask("sanctum.moods", [
        "devices.read:button",
        "workflows.manage",
      ]).then((granted) => (answer = granted));
    });

    await press("Allow");
    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(
      "Another change to Moods is still under way. Try again in a moment.",
    );
    // What was turned on stays on, and the sheet asks for the rest.
    expect(dialog()?.querySelector("h2")?.textContent).toBe(
      "Allow Moods to keep its own automations?",
    );
    expect(answer).toBeUndefined();
    // Another ask meanwhile waits, and leaves this sheet as it is.
    await act(async () => {
      void ask("sanctum.moods", ["devices.read:occupancy"]);
    });
    expect(dialog()?.querySelector('[role="alert"]')).not.toBeNull();

    await press("Try again");
    expect(granted()).toEqual([
      { permission: "devices.read:button", granted: true },
      { permission: "workflows.manage", granted: true },
      { permission: "workflows.manage", granted: true },
    ]);
    expect(answer).toBe(true);
    expect(dialog()?.querySelector("h2")?.textContent).toBe(
      "Allow Moods to know when there's motion?",
    );
  });

  it("answers Not now for an app that has gone, so the asks behind it are shown", async () => {
    const answers: boolean[] = [];
    await act(async () => {
      void ask("sanctum.example", ["people.read"]).then((each) =>
        answers.push(each),
      );
      void ask("sanctum.moods", ["devices.read:button"]).then((each) =>
        answers.push(each),
      );
    });
    await render();

    expect(answers).toEqual([false]);
    expect(dialog()?.querySelector("h2")?.textContent).toBe(
      "Allow Moods to see your remotes' presses?",
    );
  });

  it("asks one thing at a time", async () => {
    const answers: boolean[] = [];
    await act(async () => {
      void ask("sanctum.moods", ["devices.read:occupancy"]).then((each) =>
        answers.push(each),
      );
      void ask("sanctum.moods", ["devices.read:button"]).then((each) =>
        answers.push(each),
      );
    });

    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(dialog()?.querySelector("h2")?.textContent).toBe(
      "Allow Moods to know when there's motion?",
    );
    await press("Not now");
    expect(dialog()?.querySelector("h2")?.textContent).toBe(
      "Allow Moods to see your remotes' presses?",
    );
    await press("Allow");
    expect(answers).toEqual([false, true]);
  });
});

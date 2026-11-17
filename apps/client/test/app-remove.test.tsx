// @vitest-environment jsdom
import type { AppInfo, AppRemoval } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activityWords } from "../src/activity/words";
import { RemoveApp, removalWords } from "../src/app-remove";
import { CoreError, coreJson } from "../src/core-fetch";
import { entry } from "./activity-fixtures";

// Removing an app from its settings: what its dialog names, what Remove
// sends, and what the activity log says.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const example = {
  id: "sanctum.example",
  name: "Example",
  version: "1.0.0",
} as AppInfo;

const removal: AppRemoval = {
  devices: 6,
  workflows: [
    { id: "w1", name: "Hall at night" },
    { id: "w2", name: "Plug schedule" },
  ],
  widgets: 0,
  roomSections: 0,
};

let root: Root;
let container: HTMLDivElement;
let onRemoved: ReturnType<typeof vi.fn<() => void>>;

const dialog = () => document.querySelector('[role="dialog"]');
const press = async (scope: ParentNode, name: string) => {
  const button = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) => each.textContent === name,
  )!;
  await act(async () => button.click());
};

beforeEach(async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onRemoved = vi.fn();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path.endsWith("/removal")) return removal;
    if (path.endsWith("/remove")) return {};
    throw new Error(`unexpected ${path}`);
  });
  await act(async () =>
    root.render(<RemoveApp app={example} onRemoved={onRemoved} />),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.mocked(coreJson).mockReset();
});

describe("removing an app", () => {
  it("names what goes first, with the automations that turn off", async () => {
    await press(container, "Remove Example");

    const text = dialog()!.textContent;
    expect(text).toContain("Remove Example?");
    expect(text).toContain("Its 6 devices leave your home.");
    expect(text).toContain(
      "2 automations use it: Hall at night and Plug schedule. They turn off and say Example is missing.",
    );
    expect(text).toContain(
      "If you add it back within 30 days, its devices, their rooms and history and its settings come back as they were.",
    );
    // Cancel is focused.
    expect(document.activeElement?.textContent).toBe("Cancel");
  });

  it("removes it once someone says so", async () => {
    await press(container, "Remove Example");
    await press(dialog()!, "Remove");

    expect(coreJson).toHaveBeenCalledWith("/api/apps/sanctum.example/remove", {
      method: "POST",
      json: {},
    });
    expect(onRemoved).toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it("says when it can't be removed while it changes version", async () => {
    vi.mocked(coreJson).mockImplementation(async (path) => {
      if (path.endsWith("/removal")) return removal;
      throw new CoreError(409, "conflict");
    });
    await press(container, "Remove Example");
    await press(dialog()!, "Remove");

    expect(container.querySelector('[role="alert"]')!.textContent).toBe(
      "Example is changing version. Try again once it's done.",
    );
    expect(onRemoved).not.toHaveBeenCalled();
  });

  it("says only what applies", () => {
    expect(
      removalWords(example, {
        devices: 0,
        workflows: [{ id: "w1", name: "Morning" }],
        widgets: 1,
        roomSections: 1,
      }),
    ).toEqual({
      lines: ["Its widget leaves Home.", "What it shows in rooms goes too."],
      automations: {
        title: "1 automation uses it:",
        line: "Morning. It turns off and says Example is missing.",
      },
      back: "If you add it back within 30 days, its settings come back as they were.",
    });
  });

  it("is in the activity log, by the name kept once it's gone", () => {
    expect(
      activityWords(
        entry({
          kind: "setup",
          source: "sanctum.example",
          action: "app.remove",
          app: { id: "sanctum.example", name: null },
          subject: null,
          detail: { name: "Example", version: "1.0.0" },
        }),
      ),
    ).toEqual({ title: "Removed Example", detail: "Alex", problem: false });
  });
});

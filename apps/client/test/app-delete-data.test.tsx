// @vitest-environment jsdom
import { homeClock } from "@meetsanctum/app-sdk/clock";
import type { AvailableApp } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { activityWords } from "../src/activity/words";
import { DeleteAppData, deletingWords } from "../src/app-delete-data";
import { productName } from "../src/brand";
import { CoreError, coreJson } from "../src/core-fetch";
import { entry } from "./activity-fixtures";
import { problemLines } from "./problem-lines";

// The device's own zone, which the expectations here are worked out in.
const clock = homeClock();

// Deleting a removed app's data at once, from its row under Add apps: what
// the dialog says goes, what Delete sends, and what the activity log says.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const example: AvailableApp = {
  id: "sanctum.example",
  name: "Example",
  version: "1.0.0",
  summary: null,
  icon: null,
  requests: [],
  memory: 128,
  data: 256,
  adds: { devices: true },
  shortfalls: [],
  removed: {
    at: "2026-11-17T12:00:00.000Z",
    keptUntil: "2026-12-17T12:00:00.000Z",
  },
};

let root: Root;
let container: HTMLDivElement;
let onDeleted: ReturnType<typeof vi.fn<() => void>>;

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
  onDeleted = vi.fn();
  vi.mocked(coreJson).mockResolvedValue({});
  await act(async () =>
    root.render(<DeleteAppData app={example} onDeleted={onDeleted} />),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.mocked(coreJson).mockReset();
});

describe("deleting a removed app's data", () => {
  it("says what goes, and what adding it back then means", () => {
    expect(deletingWords(example)).toBe(
      "Its devices, their history and its settings are deleted, so adding it back means adding every device again.",
    );
    expect(
      deletingWords({
        ...example,
        requests: [
          {
            id: "services:zigbee2mqtt",
            reason: "To reach the network.",
            needed: true,
            asked: null,
            startsOn: false,
          },
        ],
      }),
    ).toContain(
      "Unless another app uses its network, that's erased too, so every Example device has to be paired again.",
    );
    expect(
      deletingWords({ ...example, adds: { ...example.adds, devices: false } }),
    ).toBe(
      "Its settings and what it saved are deleted, so adding it back starts it afresh.",
    );
  });

  it("warns that Ollama's models go too, including for apps that add devices", () => {
    const requests = [
      {
        id: "services:ollama",
        reason: "To run AI models on Sanctum.",
        needed: true,
        asked: null,
        startsOn: false,
      },
    ];
    const warning =
      "Unless another app uses Ollama, its downloaded models are deleted too.";
    expect(deletingWords({ ...example, requests })).toBe(
      `Its devices, their history and its settings are deleted, so adding it back means adding every device again. ${warning}`,
    );
    expect(
      deletingWords({
        ...example,
        adds: { ...example.adds, devices: false },
        requests,
      }),
    ).toBe(
      `Its settings and what it saved are deleted, so adding it back starts it afresh. ${warning}`,
    );
  });

  it("asks first, with Cancel focused, then deletes it", async () => {
    await press(container, "Delete Example's data now");
    expect(dialog()!.textContent).toContain("Delete Example's data?");
    expect(document.activeElement?.textContent).toBe("Cancel");
    // Asking deletes nothing.
    expect(coreJson).not.toHaveBeenCalled();

    await press(dialog()!, "Delete");

    expect(coreJson).toHaveBeenCalledTimes(1);
    expect(coreJson).toHaveBeenCalledWith(
      "/api/apps/sanctum.example/data/delete",
      { method: "POST", json: {} },
    );
    expect(onDeleted).toHaveBeenCalled();
    expect(dialog()).toBeNull();
  });

  it("says when this Sanctum can't delete it yet", async () => {
    vi.mocked(coreJson).mockRejectedValue(new CoreError(503, "unavailable"));
    await press(container, "Delete Example's data now");
    await press(dialog()!, "Delete");

    expect(problemLines(container.querySelector('[role="alert"]'))).toEqual([
      "Example's data wasn't all deleted",
      `Some may already be gone. ${productName} can't delete the rest right now: check for an update, then try again.`,
    ]);
    expect(onDeleted).not.toHaveBeenCalled();
  });

  it("says some may be gone when a deletion fails part way", async () => {
    vi.mocked(coreJson).mockRejectedValue(new CoreError(409, "conflict"));
    await press(container, "Delete Example's data now");
    await press(dialog()!, "Delete");

    expect(problemLines(container.querySelector('[role="alert"]'))).toEqual([
      "Example's data wasn't all deleted",
      "Some may already be gone. Sanctum ran into a problem. Try again in a moment.",
    ]);
  });

  it("gives focus back to the button once Cancel closes it", async () => {
    await press(container, "Delete Example's data now");
    await press(dialog()!, "Cancel");

    expect(dialog()).toBeNull();
    expect(document.activeElement?.textContent).toBe(
      "Delete Example's data now",
    );
  });

  it("is in the activity log, by Sanctum once its days are over", () => {
    expect(
      activityWords(
        clock,
        entry({
          kind: "setup",
          source: "sanctum.example",
          action: "app.delete",
          who: { kind: "sanctum" },
          app: { id: "sanctum.example", name: null },
          subject: null,
          detail: { name: "Example", version: "1.0.0" },
        }),
      ),
    ).toEqual({
      title: "Deleted Example's data",
      detail: productName,
      problem: false,
    });
  });
});

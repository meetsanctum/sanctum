// @vitest-environment jsdom
import type { AppInfo, AvailableApp } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { productName } from "../src/brand";
import { CoreError, coreJson } from "../src/core-fetch";
import { AddAppsSection } from "../src/settings-apps";

// Settings → Apps' Add apps: the apps the home could add, each with Add,
// and the sheet that says what one needs to work, what it starts with and
// adds, or what keeps it from being added, before any of its code runs.

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const mebibyte = 1024 * 1024;

const example: AvailableApp = {
  id: "sanctum.example",
  name: "Example",
  version: "1.0.0",
  summary: "Brings example devices into your home.",
  icon: { glyph: "cpu", color: "iris" },
  requests: [
    {
      id: "devices.provide",
      reason: "To add your example devices and keep their state.",
      needed: true,
      asked: null,
      startsOn: false,
    },
    {
      id: "devices.read:audio",
      reason: "To list your smart speakers on its page.",
      needed: true,
      asked: null,
      startsOn: false,
    },
    {
      id: "devices.read:button",
      reason: "So a press can run what you chose.",
      needed: false,
      asked: null,
      startsOn: true,
    },
    {
      id: "devices.read:motion",
      reason: "To start when someone comes in.",
      needed: false,
      asked: "when you choose a motion sensor",
      startsOn: false,
    },
  ],
  memory: 128,
  data: 256,
  adds: {
    devices: true,
    widgets: 0,
    roomSections: 0,
    devicePages: 1,
    pieces: 2,
  },
  shortfalls: [],
};

const weather = { id: "sanctum.weather", name: "Weather" } as AppInfo;
const added = {
  id: "sanctum.example",
  name: "Example",
  state: "starting",
} as AppInfo;

let root: Root;
let container: HTMLDivElement;
let available: AvailableApp[];
let onAdded: ReturnType<typeof vi.fn<(app: AppInfo) => void>>;

const render = (apps: AppInfo[] = [weather]) =>
  act(async () =>
    root.render(<AddAppsSection apps={apps} onAdded={onAdded} />),
  );
const dialog = () => document.querySelector('[role="dialog"]');
const buttonIn = (scope: ParentNode, name: string) =>
  [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (each) =>
      each.textContent === name || each.getAttribute("aria-label") === name,
  );
const press = async (scope: ParentNode, name: string) => {
  await act(async () => buttonIn(scope, name)!.click());
};

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  available = [example];
  onAdded = vi.fn();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path === "/api/apps/available") return available;
    if (path === "/api/apps/add") return added;
    throw new Error(`unexpected ${path}`);
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.mocked(coreJson).mockReset();
});

describe("Add apps", () => {
  it("lists what the home could add, each with its summary and Add", async () => {
    await render();
    const section =
      container.querySelector("#settings-add-apps")!.parentElement!
        .parentElement!.parentElement!;
    expect(section.textContent).toContain("Add Apps");
    expect(section.textContent).toContain("1 app");
    expect(section.textContent).toContain(
      "ExampleBrings example devices into your home.",
    );
    expect(buttonIn(container, "Add Example")).toBeDefined();
  });

  it("says until when the data of one the household removed is kept", async () => {
    available = [
      {
        ...example,
        removed: {
          at: "2026-11-17T12:00:00.000Z",
          keptUntil: "2026-12-17T12:00:00.000Z",
        },
      },
    ];
    await render();
    expect(container.textContent).toContain(
      "Removed on 17 November. Its data is kept until 17 December.",
    );
  });

  it("isn't there with nothing to add, nor offers one the home has now", async () => {
    available = [];
    await render();
    expect(container.textContent).not.toContain("Add Apps");

    available = [example];
    await render([weather, added]);
    expect(container.textContent).not.toContain("Add Apps");
  });

  it("says what it needs, what it starts with and what it adds before it runs", async () => {
    await render();
    await press(container, "Add Example");

    const sheet = dialog()!;
    expect(sheet.textContent).toContain("Add Example?");
    expect(sheet.textContent).toContain("It needs these to work:");
    expect(sheet.textContent).toContain(
      "To add your example devices and keep their state.",
    );
    const speakerPermission = [...sheet.querySelectorAll("li")].find((row) =>
      row.textContent?.startsWith("See your smart speakers"),
    );
    expect(speakerPermission?.textContent).toContain(
      "See whether their microphones are muted and when they last heard their wake word. To list your smart speakers on its page.",
    );
    expect(sheet.textContent).toContain(
      "It starts with this too, which you can switch off in its settings:",
    );
    expect(sheet.textContent).toContain("So a press can run what you chose.");
    // One it asks for where it's used isn't on the sheet.
    expect(sheet.textContent).not.toContain("To start when someone comes in.");
    expect(sheet.textContent).toContain(
      "It adds devices, a page in a device's detail and two workflow pieces. It uses up to 128 MB of memory.",
    );
  });

  it("adds it at the version the sheet showed, and opens onto it", async () => {
    await render();
    await press(container, "Add Example");
    await press(dialog()!, "Add Example");

    expect(coreJson).toHaveBeenCalledWith("/api/apps/add", {
      method: "POST",
      json: { id: "sanctum.example", version: "1.0.0" },
    });
    expect(onAdded).toHaveBeenCalledWith(added);
    expect(dialog()).toBeNull();
  });

  it("says what keeps it from being added, with what would help, and can't add it", async () => {
    available = [
      {
        ...example,
        shortfalls: [
          { kind: "memory", needs: 128 * mebibyte, free: 60 * mebibyte },
        ],
      },
    ];
    await render();
    await press(container, "Add Example");

    const sheet = dialog()!;
    expect(sheet.textContent).toContain(
      "There isn't room for it. It needs 128 MB of memory, and 60 MB are left beside your other apps. Turning off an app you don't use makes room.",
    );
    expect(sheet.textContent).not.toContain("It needs these to work:");
    expect(buttonIn(sheet, "Add Example")!.disabled).toBe(true);
  });

  it("says a newer Sanctum is needed for one made for it", async () => {
    available = [
      { ...example, shortfalls: [{ kind: "sanctum", range: "^2.0.0" }] },
    ];
    await render();
    await press(container, "Add Example");
    expect(dialog()!.textContent).toContain(
      `It needs a newer ${productName}. Update ${productName} in Settings, then add it.`,
    );
  });

  it("says when it changed meanwhile, and stays open", async () => {
    vi.mocked(coreJson).mockImplementation(async (path) => {
      if (path === "/api/apps/available") return available;
      throw new CoreError(409, "conflict");
    });
    await render();
    await press(container, "Add Example");
    await press(dialog()!, "Add Example");

    expect(dialog()!.querySelector('[role="alert"]')!.textContent).toBe(
      "Example changed meanwhile, as when it was added on another device. Close this and look again.",
    );
    expect(onAdded).not.toHaveBeenCalled();

    available = [{ ...example, version: "1.1.0" }];
    await press(dialog()!, "Cancel");
    await press(container, "Add Example");
    await press(dialog()!, "Add Example");
    expect(coreJson).toHaveBeenLastCalledWith("/api/apps/add", {
      method: "POST",
      json: { id: "sanctum.example", version: "1.1.0" },
    });
  });

  it("checks what is short again when the sheet is closed", async () => {
    available = [
      {
        ...example,
        shortfalls: [{ kind: "memory", needs: 128, free: 60 }],
      },
    ];
    await render();
    await press(container, "Add Example");
    expect(buttonIn(dialog()!, "Add Example")!.disabled).toBe(true);

    available = [example];
    await press(dialog()!, "Cancel");
    await press(container, "Add Example");
    expect(buttonIn(dialog()!, "Add Example")!.disabled).toBe(false);
    expect(dialog()!.textContent).toContain("It needs these to work:");
  });
});

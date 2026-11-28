// @vitest-environment jsdom
import type { AppInfo, AvailableApp } from "@meetsanctum/app-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { productName } from "../src/brand";
import { CoreError, coreJson } from "../src/core-fetch";
import { AddAppsSection } from "../src/settings-apps";
import { SettingsOpenerProvider } from "../src/settings-opener";
import { problemLines } from "./problem-lines";

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
      reason: "To add your example devices and show what they're doing.",
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
  adds: { devices: true },
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
let openSettings:
  ReturnType<typeof vi.fn<(page: string, params?: object) => void>> | undefined;

const render = (apps: AppInfo[] = [weather]) =>
  act(async () =>
    root.render(
      <SettingsOpenerProvider value={openSettings}>
        <AddAppsSection apps={apps} onAdded={onAdded} />
      </SettingsOpenerProvider>,
    ),
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
  openSettings = vi.fn();
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

  it("says what it needs, what it starts with and what it takes before it runs", async () => {
    await render();
    await press(container, "Add Example");

    const sheet = dialog()!;
    expect(sheet.textContent).toContain("Add Example?");
    expect(sheet.textContent).toContain("It needs these to work:");
    expect(sheet.textContent).toContain(
      "To add your example devices and show what they're doing.",
    );
    const speakerPermission = [...sheet.querySelectorAll("li")].find((row) =>
      row.textContent?.startsWith("See your smart speakers"),
    );
    expect(speakerPermission?.textContent).toContain(
      "Whether their microphones are muted and when they last heard their wake word. To list your smart speakers on its page.",
    );
    expect(sheet.textContent).toContain(
      "It starts with this too, which you can switch off in its settings:",
    );
    expect(sheet.textContent).toContain("So a press can run what you chose.");
    // One it asks for where it's used isn't on the sheet.
    expect(sheet.textContent).not.toContain("To start when someone comes in.");
    // Its memory and storage, side by side, and nothing of what it adds.
    expect(sheet.textContent).toContain("MemoryUp to 128 MB");
    expect(sheet.textContent).toContain("StorageUp to 256 MB");
    expect(sheet.textContent).not.toContain("It adds");
  });

  it("groups matching permissions and keeps different reasons visible", async () => {
    const reason =
      "To pair with your TVs, control them and see what they play.";
    const otherReason = "To check whether your TVs are on.";
    available = [
      {
        ...example,
        requests: [
          ...["_airplay._tcp", "_companion-link._tcp"].map((service) => ({
            id: `discover:mdns:${service}`,
            reason: "To find your TVs.",
            needed: true,
            asked: null,
            startsOn: false,
          })),
          ...["lan:tcp:7000", "lan:tcp:49152-65535"].map((id) => ({
            id,
            reason,
            needed: true,
            asked: null,
            startsOn: false,
          })),
          {
            id: "lan:tcp:7001",
            reason: otherReason,
            needed: true,
            asked: null,
            startsOn: false,
          },
        ],
      },
    ];
    await render();
    await press(container, "Add Example");

    expect(
      [...dialog()!.querySelectorAll("li")].map((row) => row.textContent),
    ).toEqual([
      "Find devices on your networkTo find your TVs.",
      `Talk to devices on your networkOnly the devices it found. ${reason}`,
      `Talk to devices on your networkOnly the devices it found. ${otherReason}`,
    ]);
  });

  it.each([
    ["ollama", 4096, "About 4.1 GB", "A few GB per model"],
    ["ollama", null, "Not known now", "A few GB per model"],
    ["zigbee2mqtt", 288, "About 416 MB", "Up to 256 MB"],
  ] as const)(
    "shows the resource totals with %s and a service allowance of %s",
    async (service, servicesMemory, memory, storage) => {
      available = [
        {
          ...example,
          requests: [
            {
              id: `services:${service}`,
              reason: "To run the service.",
              needed: true,
              asked: null,
              startsOn: false,
            },
          ],
          servicesMemory,
        },
      ];
      await render();
      await press(container, "Add Example");

      expect(dialog()!.textContent).toContain(`Memory${memory}`);
      expect(dialog()!.textContent).toContain(`Storage${storage}`);
    },
  );

  it("adds it at the version the sheet showed, and opens onto it", async () => {
    await render();
    await press(container, "Add Example");
    await press(dialog()!, "Add");

    expect(coreJson).toHaveBeenCalledWith("/api/apps/add", {
      method: "POST",
      json: { id: "sanctum.example", version: "1.0.0" },
    });
    expect(onAdded).toHaveBeenCalledWith(added);
    expect(dialog()).toBeNull();
  });

  it.each([
    {
      shortfall: {
        kind: "space" as const,
        needs: 256 * mebibyte,
        free: 0,
        toFree: 1.14 * 1024 * mebibyte,
      },
      title: "Not enough storage for Example",
      line: `To add Example, free up 1.23 GB. ${productName} keeps some storage free for updates and for your other apps.`,
      fix: "Free up space",
      opens: ["system", { card: "storage" }],
    },
    {
      // An older core says only what's free.
      shortfall: {
        kind: "space" as const,
        needs: 256 * mebibyte,
        free: 100 * mebibyte,
      },
      title: "Not enough storage for Example",
      line: `To add Example, free up 164 MB. ${productName} keeps some storage free for updates and for your other apps.`,
      fix: "Free up space",
      opens: ["system", { card: "storage" }],
    },
    {
      shortfall: {
        kind: "space" as const,
        needs: 256 * mebibyte,
        free: 0,
      },
      title: "Not enough storage for Example",
      line: `To add Example, free up some storage. ${productName} keeps some storage free for updates and for your other apps.`,
      fix: "Free up space",
      opens: ["system", { card: "storage" }],
    },
    {
      shortfall: {
        kind: "memory" as const,
        needs: 128 * mebibyte,
        free: 60 * mebibyte,
      },
      title: "Not enough memory for Example",
      line: "To add Example, turn off an app you don't use. Your other apps take the memory Example needs.",
      fix: "Show apps",
      opens: ["apps", undefined],
    },
    {
      shortfall: { kind: "sanctum" as const, range: "^2.0.0" },
      title: `Example needs a newer ${productName}`,
      line: `Update ${productName}, then add Example.`,
      fix: `Update ${productName}`,
      opens: ["system", { card: "updates" }],
    },
    {
      shortfall: { kind: "pages" as const, needs: "pages" as const },
      title: "Example is out of date",
      line: `A newer Example comes with an update of ${productName}. Update ${productName}, then add Example.`,
      fix: `Update ${productName}`,
      opens: ["system", { card: "updates" }],
    },
  ])(
    "says $title, with what would help, and $fix leads there",
    async ({ shortfall, title, line, fix, opens }) => {
      available = [{ ...example, shortfalls: [shortfall] }];
      await render();
      await press(container, "Add Example");

      const sheet = dialog()!;
      expect(sheet.querySelector("h2")!.textContent).toBe(title);
      expect(sheet.textContent).toContain(line);
      expect(sheet.textContent).not.toContain("It needs these to work:");
      expect(buttonIn(sheet, "Add")).toBeUndefined();
      expect(buttonIn(sheet, "Cancel")).toBeDefined();

      await press(sheet, fix);
      expect(dialog()).toBeNull();
      expect(openSettings).toHaveBeenCalledWith(...opens);
    },
  );

  it("shows the memory shortfall without a repair action when no app can be turned off", async () => {
    available = [
      {
        ...example,
        shortfalls: [
          { kind: "memory", needs: 1152 * mebibyte, free: 1024 * mebibyte },
        ],
      },
    ];
    await render([]);
    await press(container, "Add Example");

    const sheet = dialog()!;
    expect(sheet.textContent).toContain(
      `Example needs more memory than ${productName} can give it.`,
    );
    expect(buttonIn(sheet, "Show apps")).toBeUndefined();
    expect(buttonIn(sheet, "Add")!.disabled).toBe(true);
  });

  it("can't add one that doesn't fit where Settings can't be opened", async () => {
    openSettings = undefined;
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

    expect(buttonIn(dialog()!, "Show apps")).toBeUndefined();
    expect(buttonIn(dialog()!, "Add")!.disabled).toBe(true);
  });

  it("says when it changed meanwhile, and stays open", async () => {
    vi.mocked(coreJson).mockImplementation(async (path) => {
      if (path === "/api/apps/available") return available;
      throw new CoreError(409, "conflict");
    });
    await render();
    await press(container, "Add Example");
    await press(dialog()!, "Add");

    expect(problemLines(dialog()!.querySelector('[role="alert"]'))).toEqual([
      "Couldn't add Example",
      "It changed meanwhile, as when it was added on another device. Close this and look again.",
    ]);
    expect(onAdded).not.toHaveBeenCalled();

    available = [{ ...example, version: "1.1.0" }];
    await press(dialog()!, "Cancel");
    await press(container, "Add Example");
    await press(dialog()!, "Add");
    expect(coreJson).toHaveBeenLastCalledWith("/api/apps/add", {
      method: "POST",
      json: { id: "sanctum.example", version: "1.1.0" },
    });
  });

  it("checks what is short again when the sheet is closed", async () => {
    openSettings = undefined;
    available = [
      {
        ...example,
        shortfalls: [{ kind: "memory", needs: 128, free: 60 }],
      },
    ];
    await render();
    await press(container, "Add Example");
    expect(buttonIn(dialog()!, "Add")!.disabled).toBe(true);

    available = [example];
    await press(dialog()!, "Cancel");
    await press(container, "Add Example");
    expect(buttonIn(dialog()!, "Add")!.disabled).toBe(false);
    expect(dialog()!.textContent).toContain("It needs these to work:");
  });
});

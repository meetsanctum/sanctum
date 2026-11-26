// @vitest-environment jsdom
import { homeClock } from "@meetsanctum/app-sdk/clock";
import type { ClientInfo, SetClientDrawing } from "@meetsanctum/auth-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CoreError, coreJson } from "../src/core-fetch";
import {
  ClientsSection,
  clientDetail,
  seenText,
} from "../src/settings-clients";

// The device's own zone, which the expectations here are worked out in.
const clock = homeClock();

vi.mock("../src/core-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/core-fetch")>()),
  coreJson: vi.fn(),
}));

const now = new Date("2026-10-28T12:00:00Z");
const maya = {
  id: "maya",
  name: "Maya",
  avatar: null,
  colour: "#c5cdac",
} as const;
const macbook: ClientInfo = {
  id: "macbook",
  name: "Maya's MacBook",
  kind: "personal",
  platform: "macos",
  personId: "maya",
  createdAt: "2026-10-26T12:00:00Z",
  lastSeenAt: "2026-10-28T11:59:30Z",
  connectedSince: null,
  current: true,
  reduceEffects: false,
  reduceMotion: false,
};
const tablet: ClientInfo = {
  id: "tablet",
  name: "Kitchen tablet",
  kind: "shared",
  platform: "web",
  personId: null,
  createdAt: "2026-10-28T11:50:00Z",
  lastSeenAt: null,
  connectedSince: null,
  current: false,
  reduceEffects: false,
  reduceMotion: false,
};

describe("a client's detail", () => {
  it.each([
    [null, "Never seen"],
    ["2026-10-28T11:59:00Z", "Seen just now"],
    ["2026-10-28T11:35:00Z", "Seen 25 minutes ago"],
    ["2026-10-28T10:30:00Z", "Seen an hour ago"],
    ["2026-10-28T03:00:00Z", "Seen 9 hours ago"],
  ])("says when it was last seen (%s)", (lastSeenAt, text) => {
    expect(seenText(clock, lastSeenAt, now)).toBe(text);
  });

  it("uses the home's date for a device last seen more than a day ago", () => {
    const zurich = homeClock({ timeZone: "Europe/Zurich" });
    expect(
      seenText(
        zurich,
        "2026-10-27T23:30:00Z",
        new Date("2026-10-29T12:00:00Z"),
      ),
    ).toBe("Seen on 28 Oct");
  });

  it("names its person, or the household, its platform and when it was seen", () => {
    expect(clientDetail(clock, tablet, undefined, now)).toBe(
      "Shared · Web browser · Never seen",
    );
    expect(clientDetail(clock, macbook, maya, now)).toBe(
      "Maya · macOS · This device",
    );
  });

  it.each([
    [true, true, " · Reduced effects and motion"],
    [true, false, " · Reduced effects"],
    [false, true, " · Reduced motion"],
    [false, false, ""],
  ] as const)(
    "says what it draws with, Reduce effects %s and Reduce motion %s",
    (reduceEffects, reduceMotion, said) => {
      const client = { ...tablet, reduceEffects, reduceMotion };
      expect(clientDetail(clock, client, undefined, now)).toBe(
        `Shared · Web browser · Never seen${said}`,
      );
    },
  );
});

describe("Settings → Clients", () => {
  let root: Root;
  let container: HTMLDivElement;
  let drawing: unknown[];
  let shownMacbook: ClientInfo;
  let shownTablet: ClientInfo;

  beforeEach(async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    drawing = [];
    shownMacbook = macbook;
    shownTablet = tablet;
    vi.mocked(coreJson).mockReset();
    vi.mocked(coreJson).mockImplementation(async (path, init = {}) => {
      switch (path) {
        case "/api/auth/clients":
          return [shownMacbook, shownTablet];
        case "/api/people":
          return [maya];
        case "/api/auth/clients/drawing":
          drawing.push(init.json);
          shownTablet = {
            ...shownTablet,
            ...(init.json as SetClientDrawing),
          };
          return shownTablet;
        default:
          throw new Error(`Unexpected request: ${path}`);
      }
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root.render(<ClientsSection />));
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // Sets an input's value the way typing does, so React sees it.
  async function type(input: HTMLInputElement, value: string) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )!.set!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  function button(name: string) {
    return [...document.querySelectorAll("button")].find(
      (candidate) => candidate.textContent === name,
    )!;
  }

  async function editClient(name: string, action: string) {
    const trigger = document.querySelector<HTMLButtonElement>(
      `button[aria-label="${name}: more"]`,
    )!;
    await act(async () =>
      trigger.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      ),
    );
    const item = [
      ...document.querySelectorAll<HTMLElement>("[role=menuitem]"),
    ].find((candidate) => candidate.textContent === action)!;
    await act(async () => item.click());
  }

  // A setting's switch, by its label.
  function toggle(setting: string) {
    const label = [...document.querySelectorAll("[role=dialog] label")].find(
      (each) => each.textContent === setting,
    )!;
    return document.getElementById(label.getAttribute("for")!)!;
  }

  const isOn = (setting: string) =>
    toggle(setting).getAttribute("aria-checked") === "true";

  async function refreshClients() {
    const visibility = vi.spyOn(document, "visibilityState", "get");
    try {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      visibility.mockReturnValue("visible");
      await act(async () =>
        document.dispatchEvent(new Event("visibilitychange")),
      );
    } finally {
      visibility.mockRestore();
    }
  }

  it("turns a client's Reduce effects and Reduce motion on and off, each on its own", async () => {
    await editClient("Kitchen tablet", "Effects and motion");
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.textContent).toContain("Effects and motion");
    expect(toggle("Reduce effects").getAttribute("role")).toBe("switch");
    expect(isOn("Reduce effects")).toBe(false);
    expect(isOn("Reduce motion")).toBe(false);
    expect(
      document.getElementById(
        toggle("Reduce effects").getAttribute("aria-describedby")!,
      )!.textContent,
    ).toContain("Without blur");

    await act(async () => toggle("Reduce effects").click());
    expect(drawing).toEqual([{ id: "tablet", reduceEffects: true }]);
    expect(isOn("Reduce effects")).toBe(true);
    expect(isOn("Reduce motion")).toBe(false);

    await act(async () => toggle("Reduce motion").click());
    expect(drawing.at(-1)).toEqual({ id: "tablet", reduceMotion: true });
    await act(async () => toggle("Reduce effects").click());
    expect(drawing.at(-1)).toEqual({ id: "tablet", reduceEffects: false });
    expect(isOn("Reduce effects")).toBe(false);
    expect(isOn("Reduce motion")).toBe(true);
    expect(container.textContent).toContain(
      "Shared · Web browser · Never seen · Reduced motion",
    );

    await act(async () => button("Done").click());
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("puts a switch back where it couldn't be saved", async () => {
    await editClient("Kitchen tablet", "Effects and motion");
    vi.mocked(coreJson).mockRejectedValueOnce(new CoreError(500, "unknown"));
    await act(async () => toggle("Reduce effects").click());
    expect(isOn("Reduce effects")).toBe(false);
    expect(
      document.querySelector("[role=dialog] [role=alert]")!.textContent,
    ).toBe("That did not work. Try again.");
  });

  it("keeps a saved switch value when the client list cannot refresh", async () => {
    await editClient("Kitchen tablet", "Effects and motion");
    const original = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation((path, init) =>
      path === "/api/auth/clients"
        ? Promise.reject(new CoreError(500, "unknown"))
        : original(path, init),
    );

    await act(async () => toggle("Reduce effects").click());

    expect(drawing).toEqual([{ id: "tablet", reduceEffects: true }]);
    expect(isOn("Reduce effects")).toBe(true);
    expect(isOn("Reduce motion")).toBe(false);
    expect(container.textContent).toContain("Reduced effects");
    expect(document.querySelector("[role=dialog] [role=alert]")).toBeNull();
  });

  it("lets a press go while a save is on its way, and keeps its failure out of a reopened dialog", async () => {
    await editClient("Kitchen tablet", "Effects and motion");
    let refuseSave!: (error: Error) => void;
    const save = new Promise<ClientInfo>((_, reject) => {
      refuseSave = reject;
    });
    vi.mocked(coreJson).mockReturnValueOnce(save);
    await act(async () => toggle("Reduce effects").click());
    await act(async () => toggle("Reduce motion").click());
    expect(drawing).toEqual([]);
    expect(isOn("Reduce motion")).toBe(false);

    await act(async () => button("Done").click());
    await editClient("Kitchen tablet", "Effects and motion");
    await act(async () => refuseSave(new CoreError(500, "unknown")));
    expect(document.querySelector("[role=dialog] [role=alert]")).toBeNull();
    expect(isOn("Reduce effects")).toBe(false);
  });

  it("updates the open dialog when they are changed elsewhere", async () => {
    await editClient("Kitchen tablet", "Effects and motion");
    shownTablet = { ...shownTablet, reduceMotion: true };
    await refreshClients();
    expect(isOn("Reduce motion")).toBe(true);
    expect(isOn("Reduce effects")).toBe(false);
    shownTablet = { ...shownTablet, reduceMotion: false };
    await refreshClients();
    expect(isOn("Reduce motion")).toBe(false);
  });

  it.each([false, true])(
    "keeps newer switch values when an earlier save's answer arrives (refresh fails: %s)",
    async (refreshFails) => {
      await editClient("Kitchen tablet", "Effects and motion");
      let finishSave!: (client: ClientInfo) => void;
      vi.mocked(coreJson).mockReturnValueOnce(
        new Promise<ClientInfo>((resolve) => {
          finishSave = resolve;
        }),
      );
      await act(async () => toggle("Reduce effects").click());
      shownTablet = { ...tablet, reduceEffects: true, reduceMotion: true };
      await refreshClients();
      expect(isOn("Reduce motion")).toBe(true);

      if (refreshFails) {
        vi.mocked(coreJson).mockRejectedValueOnce(
          new CoreError(500, "unknown"),
        );
      }
      await act(async () =>
        finishSave({ ...tablet, reduceEffects: true, reduceMotion: false }),
      );
      expect(isOn("Reduce effects")).toBe(true);
      expect(isOn("Reduce motion")).toBe(true);
      expect(container.textContent).toContain("Reduced effects and motion");
    },
  );

  it("shows no switches for a core from before them, and says to update", async () => {
    const old = { reduceEffects: "automatic", reduceMotion: "on" };
    shownTablet = { ...tablet, ...(old as unknown as Partial<ClientInfo>) };
    await refreshClients();
    expect(container.textContent).toContain(
      "Shared · Web browser · Never seen",
    );
    expect(container.textContent).not.toContain("Reduced");
    await editClient("Kitchen tablet", "Effects and motion");
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.textContent).toContain(
      "Update Sanctum in your home to change these settings.",
    );
    expect(dialog.querySelector("[role=switch]")).toBeNull();
  });

  it("takes the next press while Clients are still being read after a save", async () => {
    await editClient("Kitchen tablet", "Effects and motion");
    await act(async () => toggle("Reduce effects").click());
    const reading = new Promise<never>(() => {});
    vi.mocked(coreJson).mockImplementation(async (path, init) => {
      if (path === "/api/auth/clients" || path === "/api/people") {
        return reading;
      }
      drawing.push(init?.json);
      shownTablet = { ...shownTablet, ...(init?.json as SetClientDrawing) };
      return shownTablet;
    });
    await act(async () => toggle("Reduce motion").click());
    expect(drawing.at(-1)).toEqual({ id: "tablet", reduceMotion: true });
    expect(isOn("Reduce effects")).toBe(true);
    expect(isOn("Reduce motion")).toBe(true);
  });

  it("lists every client, marking those never seen", () => {
    expect(container.textContent).toContain("Maya's MacBook");
    expect(container.textContent).toContain("Kitchen tablet");
    expect(container.textContent).toContain(
      "Shared · Web browser · Never seen",
    );
  });

  it("keeps a newer edit open when an earlier rename finishes", async () => {
    const original = vi.mocked(coreJson).getMockImplementation()!;
    let finishRename!: (value: unknown) => void;
    vi.mocked(coreJson).mockImplementation((path, init) =>
      path === "/api/auth/clients/rename"
        ? new Promise((resolve) => {
            finishRename = resolve;
          })
        : original(path, init),
    );
    await editClient("Kitchen tablet", "Rename");
    await type(document.querySelector("[role=dialog] input")!, "Hall tablet");
    await act(async () => button("Save").click());
    await act(async () => button("Cancel").click());
    await editClient("Maya's MacBook", "Rename");
    await act(async () => finishRename(undefined));

    const input = document.querySelector<HTMLInputElement>(
      "[role=dialog] input",
    );
    expect(input?.value).toBe("Maya's MacBook");
  });
});

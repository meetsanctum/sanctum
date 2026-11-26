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
  reduceEffects: "automatic",
  reduceMotion: "automatic",
  drawingRevision: 0,
  drawn: null,
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
  reduceEffects: "automatic",
  reduceMotion: "automatic",
  drawingRevision: 0,
  drawn: null,
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
    ["reduced", "reduced", " · Reduced effects and motion"],
    ["reduced", "regular", " · Reduced effects"],
    ["regular", "reduced", " · Reduced motion"],
    ["regular", "regular", ""],
  ] as const)(
    "says what it draws with, effects %s and motion %s",
    (effects, motion, said) => {
      const drawn = { effects, motion, slowDevice: false };
      expect(clientDetail(clock, { ...tablet, drawn }, undefined, now)).toBe(
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
            drawingRevision: shownTablet.drawingRevision + 1,
            drawn: null,
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

  function settingGroup(setting: string) {
    const name = [...document.querySelectorAll("[role=dialog] span")].find(
      (span) => span.textContent === setting,
    )!;
    return document.querySelector(`[aria-labelledby="${name.id}"]`)!;
  }

  function choice(setting: string, option: string) {
    return [...settingGroup(setting).querySelectorAll("button")].find(
      (each) => each.textContent === option,
    )!;
  }

  function statusRegion(setting: string) {
    return settingGroup(setting).parentElement!.querySelector(
      '[aria-live="polite"]',
    )!;
  }

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

  it("sets a client's effects and motion, Reduce motion turning on with Reduce effects", async () => {
    await editClient("Kitchen tablet", "Effects and motion");
    const dialog = document.querySelector<HTMLElement>("[role=dialog]")!;
    expect(dialog.textContent).toContain("Effects and motion");
    expect(choice("Reduce effects", "Automatic").dataset.state).toBe("on");
    // Nothing under the choices until Automatic has something on now.
    expect(dialog.textContent).not.toContain("On, ");

    await act(async () => choice("Reduce effects", "On").click());
    expect(drawing).toEqual([
      { id: "tablet", reduceEffects: "on", reduceMotion: "on" },
    ]);
    expect(choice("Reduce motion", "On").dataset.state).toBe("on");

    // Reduce motion keeps its own choice from then on.
    await act(async () => choice("Reduce motion", "Off").click());
    expect(drawing.at(-1)).toEqual({ id: "tablet", reduceMotion: "off" });
    await act(async () => choice("Reduce effects", "Off").click());
    expect(drawing.at(-1)).toEqual({ id: "tablet", reduceEffects: "off" });
    expect(choice("Reduce motion", "Off").dataset.state).toBe("on");

    await act(async () => button("Done").click());
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("puts a choice back where it couldn't be saved", async () => {
    await editClient("Kitchen tablet", "Effects and motion");
    vi.mocked(coreJson).mockRejectedValueOnce(new CoreError(500, "unknown"));
    await act(async () => choice("Reduce effects", "On").click());
    expect(choice("Reduce effects", "Automatic").dataset.state).toBe("on");
    expect(choice("Reduce motion", "Automatic").dataset.state).toBe("on");
    expect(
      document.querySelector("[role=dialog] [role=alert]")!.textContent,
    ).toBe("That did not work. Try again.");
  });

  it("lets a pick go while a save is on its way, and keeps its failure out of a reopened dialog", async () => {
    await editClient("Kitchen tablet", "Effects and motion");
    let refuseSave!: (error: Error) => void;
    const save = new Promise<ClientInfo>((_, reject) => {
      refuseSave = reject;
    });
    vi.mocked(coreJson).mockReturnValueOnce(save);
    await act(async () => choice("Reduce effects", "On").click());
    await act(async () => choice("Reduce motion", "Off").click());
    expect(drawing).toEqual([]);

    await act(async () => button("Done").click());
    await editClient("Kitchen tablet", "Effects and motion");
    await act(async () => refuseSave(new CoreError(500, "unknown")));
    expect(document.querySelector("[role=dialog] [role=alert]")).toBeNull();
    expect(choice("Reduce effects", "Automatic").dataset.state).toBe("on");
  });

  it("updates the open dialog when choices are changed elsewhere", async () => {
    await editClient("Kitchen tablet", "Effects and motion");
    const effectsStatus = statusRegion("Reduce effects");
    const motionStatus = statusRegion("Reduce motion");
    expect(effectsStatus.textContent).toBe("");
    shownTablet = {
      ...shownTablet,
      reduceMotion: "on",
      drawingRevision: 1,
      drawn: { effects: "reduced", motion: "reduced", slowDevice: false },
    };
    await refreshClients();
    expect(choice("Reduce motion", "On").dataset.state).toBe("on");
    expect(statusRegion("Reduce effects")).toBe(effectsStatus);
    expect(effectsStatus.textContent).toBe(
      "On, Kitchen tablet's accessibility settings",
    );
    expect(
      settingGroup("Reduce effects")
        .getAttribute("aria-describedby")
        ?.split(" "),
    ).toContain(effectsStatus.id);
    expect(motionStatus.textContent).toBe("");
    expect(
      settingGroup("Reduce motion")
        .getAttribute("aria-describedby")
        ?.split(" "),
    ).not.toContain(motionStatus.id);
    shownTablet = {
      ...shownTablet,
      reduceMotion: "off",
      drawingRevision: 2,
      drawn: null,
    };
    await refreshClients();
    expect(choice("Reduce motion", "Off").dataset.state).toBe("on");
    expect(statusRegion("Reduce effects")).toBe(effectsStatus);
    expect(effectsStatus.textContent).toBe("");

    await act(async () => choice("Reduce effects", "On").click());
    expect(drawing).toEqual([
      { id: "tablet", reduceEffects: "on", reduceMotion: "on" },
    ]);
  });

  it.each([
    ["Reduce effects", "reduceEffects"],
    ["Reduce motion", "reduceMotion"],
  ] as const)(
    "waits for an Automatic report when changing %s from On",
    async (setting, key) => {
      shownTablet = {
        ...tablet,
        [key]: "on",
        drawingRevision: 1,
        drawn: { effects: "reduced", motion: "reduced", slowDevice: false },
      };
      await refreshClients();
      await editClient(tablet.name, "Effects and motion");

      let finishSave!: (client: ClientInfo) => void;
      const save = new Promise<ClientInfo>((resolve) => {
        finishSave = resolve;
      });
      vi.mocked(coreJson).mockReturnValueOnce(save);
      await act(async () => choice(setting, "Automatic").click());

      expect(choice(setting, "Automatic").dataset.state).toBe("on");
      expect(statusRegion(setting).textContent).toBe("");
      await act(async () => finishSave({ ...tablet, drawingRevision: 2 }));
      expect(statusRegion(setting).textContent).toBe("");
    },
  );

  it("credits low performance when Automatic reduces effects on a slow device", async () => {
    shownTablet = {
      ...tablet,
      drawn: { effects: "reduced", motion: "reduced", slowDevice: true },
    };
    await refreshClients();
    await editClient(tablet.name, "Effects and motion");

    const status = statusRegion("Reduce effects");
    expect(status.textContent).toBe("On, Low performance detected");
    // Only On is green; the reason is grey.
    const [on, reason] = [...status.firstElementChild!.children];
    expect(on!.className).toContain("text-green");
    expect(reason!.className).toContain("text-muted-foreground");
    expect(reason!.className).not.toContain("text-green");
  });

  it("credits this device's accessibility settings when only Automatic motion is reduced", async () => {
    shownMacbook = {
      ...macbook,
      drawn: { effects: "regular", motion: "reduced", slowDevice: false },
    };
    await refreshClients();
    await editClient(macbook.name, "Effects and motion");

    expect(statusRegion("Reduce effects").textContent).toBe("");
    const motionStatus = statusRegion("Reduce motion");
    expect(motionStatus.textContent).toBe(
      "On, This device's accessibility settings",
    );
    expect(
      settingGroup("Reduce motion")
        .getAttribute("aria-describedby")
        ?.split(" "),
    ).toContain(motionStatus.id);
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

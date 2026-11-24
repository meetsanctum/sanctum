// @vitest-environment jsdom
import type { CapabilityInfo, DeviceInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HostedApp } from "../src/apps";
import { useArtwork } from "../src/artwork";
import { coreJson } from "../src/core-fetch";
import { DeviceDetail } from "../src/device-detail";
import { sectionsOfRoom, tilesOf } from "../src/device-tiles";
import { forgetPageTicket } from "../src/frames/page-ticket";
import { missingArtworkTint } from "../src/media-detail";
import { useDevices } from "../src/use-devices";
import { devicePageAnswer, pressesApp } from "./device-detail-app-fixtures";
import { motionCapability } from "./device-tiles-fixtures";
import { unknownHome } from "./home-fixtures";
import {
  contactSensor,
  light,
  mediaPlayer,
  places,
  plug,
  sensor,
} from "./place-pages-fixtures";

vi.mock("../src/core-fetch", () => ({
  coreJson: vi.fn(),
  currentCredential: () => ({ token: "client" }),
}));
vi.mock("../src/artwork", () => ({ useArtwork: vi.fn(() => null) }));

// A device's detail is the device's, whichever of its tiles opened it: the
// same pages in the same order, opening on the page of the tile pressed.

let root: Root;
let container: HTMLDivElement;
let live: ReturnType<typeof createLiveFeed>;
let devices: DeviceInfo[];

const presses = pressesApp(["devices.read:button"]);
const driver = pressesApp(["devices.register"]);
driver.info.id = "sanctum.example";
driver.info.name = "Example";
driver.info.provides.devicePages = [
  { id: "example.status", title: "Status", kinds: [], devices: "own" },
];

const button: CapabilityInfo = {
  id: "button",
  kind: "button",
  features: { actions: ["single"], holds: [] },
  state: null,
  observed: null,
  desired: null,
  sync: "synced",
  setBy: null,
  changedAt: null,
};

const audio: CapabilityInfo = {
  id: "audio",
  kind: "audio",
  features: { mutes: true, muteSwitch: false },
  state: { muted: false },
  observed: { muted: false },
  desired: null,
  sync: "synced",
  setBy: null,
  changedAt: null,
};

// A light with a button and a temperature sensor, as an ESPHome panel.
const panel: DeviceInfo = {
  ...light("panel", "Desk panel", "office", true),
  driver: driver.info.id,
  capabilities: [
    ...light("panel", "", null, true).capabilities,
    button,
    sensor("panel", "office", 22, 48).capabilities[0]!,
  ],
};

// A module with two relays.
const relay: DeviceInfo = {
  ...plug,
  id: "relay",
  name: "Relay",
  capabilities: [
    { ...plug.capabilities[0]!, id: "1" },
    {
      ...plug.capabilities[0]!,
      id: "2",
      state: { on: false },
      observed: { on: false },
    } as CapabilityInfo,
  ],
};

function Detail(props: {
  tileKey: string;
  open?: boolean;
  openFirstPage?: boolean;
  apps?: readonly HostedApp[];
}) {
  const shown = useDevices(live);
  return (
    <DeviceDetail
      container={container}
      tileKey={props.tileKey}
      openFirstPage={props.openFirstPage}
      open={props.open ?? true}
      devices={shown}
      apps={props.apps ?? [presses]}
      live={live}
      home={unknownHome}
      onClose={() => {}}
      onCovering={() => {}}
      onShowActivity={() => {}}
      onOpenAppSettings={() => {}}
      onOpenStatus={() => {}}
    />
  );
}

async function open(
  tileKey: string,
  options: { openFirstPage?: boolean; apps?: readonly HostedApp[] } = {},
) {
  await act(async () => root.render(<Detail tileKey={tileKey} {...options} />));
  await act(async () => live.refresh());
}

const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]')!;
const tabs = () =>
  [...dialog().querySelectorAll('[role="tab"]')].map((each) => [
    each.getAttribute("aria-label"),
    each.getAttribute("aria-selected"),
  ]);
const posted = () =>
  vi
    .mocked(coreJson)
    .mock.calls.filter(([path]) => path === "/api/devices/command")
    .map(([, init]) => init?.json);

beforeEach(() => {
  forgetPageTicket();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  live = createLiveFeed();
  devices = [panel, relay];
  vi.mocked(useArtwork).mockReturnValue(null);
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path, init) => {
    const page =
      devicePageAnswer(path, presses.info.id) ??
      devicePageAnswer(path, driver.info.id);
    if (page) return page;
    if (path === "/api/devices") return devices;
    if (path === "/api/places") return places;
    if (path === "/api/devices/command") return { ok: true, init };
    if (path.startsWith("/api/activity?")) return { entries: [], more: false };
    if (path.startsWith("/api/history/")) {
      const query = new URL(path, "http://core").searchParams;
      return {
        device: query.get("device"),
        capability: query.get("capability"),
        kind: "sensor",
        from: query.get("from"),
        to: query.get("to"),
        kept: false,
        states: [],
        period: query.get("period"),
        fields: {},
      };
    }
    throw new Error(`Unexpected ${path}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("keeps the opening tint on Remote and updates it on Playing", async () => {
  const tv = mediaPlayer("tv", "TV", "office", {
    on: true,
    activity: "paused",
  });
  devices = [tv];
  const first = "oklch(0.4 0.1 40)";
  const next = "oklch(0.4 0.1 80)";
  const tint = () =>
    dialog()
      .querySelector("[data-tint]:last-of-type")
      ?.getAttribute("data-tint");
  const select = (page: string) =>
    act(async () => {
      dialog()
        .querySelector<HTMLButtonElement>(`[role=tab][aria-label=${page}]`)!
        .click();
    });

  vi.mocked(useArtwork).mockReturnValue({ url: "blob:first", colour: first });
  await open("tv/player");
  expect(tint()).toBe(first);
  await select("Remote");

  vi.mocked(useArtwork).mockReturnValue({ url: "blob:next", colour: next });
  await act(async () =>
    live.publish({ type: "device", id: tv.id, device: { ...tv } }),
  );
  expect(tint()).toBe(first);

  await select("Playing");
  expect(tint()).toBe(next);
});

it.each([
  ["a TV", true, "Remote"],
  ["a speaker", false, "Volume"],
])("gives %s its History before its Activity", async (_, power, second) => {
  devices = [
    mediaPlayer(
      "tv",
      "TV",
      "office",
      { activity: "paused" },
      { power, volume: "level" },
    ),
  ];
  await open("tv/player");
  expect(tabs().map(([label]) => label)).toEqual([
    "Playing",
    second,
    "History",
    "Activity",
  ]);
});

it("shows a smart speaker with a button by its playback, and mutes from Microphones", async () => {
  const speaker = mediaPlayer("speaker", "Speaker", "office", {
    activity: "idle",
  });
  devices = [
    {
      ...speaker,
      type: "smart-speaker",
      capabilities: [button, ...speaker.capabilities, audio],
    },
  ];
  const sections = sectionsOfRoom(tilesOf(devices, places), devices);
  expect(sections.map(({ id, tiles }) => [id, tiles[0]?.capabilityId])).toEqual(
    [["media", "player"]],
  );
  await open("speaker/player");
  const tab = dialog().querySelector<HTMLButtonElement>(
    '[role="tab"][aria-label="Microphones"]',
  )!;
  await act(async () => tab.click());
  const microphones =
    dialog().querySelector<HTMLButtonElement>('[role="switch"]')!;
  expect(microphones.getAttribute("aria-checked")).toBe("true");
  await act(async () => microphones.click());
  expect(posted()).toEqual([
    { device: "speaker", capability: "audio", command: { muted: true } },
  ]);
});

it.each(["player", "relay"])(
  "reads History for the %s tile on a device with media and a switch",
  async (capability) => {
    const tv = mediaPlayer("tv", "TV", "office", { activity: "idle" });
    devices = [
      {
        ...tv,
        capabilities: [
          ...tv.capabilities,
          { ...plug.capabilities[0]!, id: "relay" },
        ],
      },
    ];
    await open(`tv/${capability}`);
    const historyTab = dialog().querySelector<HTMLButtonElement>(
      '[role="tab"][aria-label="History"]',
    )!;
    await act(async () => historyTab.click());

    expect(
      vi
        .mocked(coreJson)
        .mock.calls.map(([path]) => path)
        .filter((path) => path.startsWith("/api/history/states?"))
        .map((path) =>
          new URL(path, "http://core").searchParams.get("capability"),
        ),
    ).toEqual([capability]);
  },
);

it("asks for the same artwork again when the detail is reopened", async () => {
  const hash = "a".repeat(64);
  devices = [
    mediaPlayer("tv", "TV", "office", {
      on: true,
      activity: "paused",
      media: { artwork: hash },
    }),
  ];
  await open("tv/player");
  expect(useArtwork).toHaveBeenLastCalledWith(hash);
  await act(async () =>
    root.render(<Detail tileKey="tv/player" open={false} />),
  );
  expect(useArtwork).toHaveBeenLastCalledWith(null);
  await open("tv/player");
  expect(useArtwork).toHaveBeenLastCalledWith(hash);
});

it("uses the placeholder tint on image failure and the new tint on replacement", async () => {
  const tv = mediaPlayer("tv", "TV", "office", {
    on: true,
    activity: "paused",
    media: { artwork: "a".repeat(64) },
  });
  devices = [tv];
  const image = () => dialog().querySelector("img");
  const tint = () =>
    dialog()
      .querySelector("[data-tint]:last-of-type")
      ?.getAttribute("data-tint");

  vi.mocked(useArtwork).mockReturnValue({ url: "blob:broken", colour: null });
  await open("tv/player");
  await act(async () => image()!.dispatchEvent(new Event("error")));
  expect(image()).toBeNull();
  expect(tint()).toBe(missingArtworkTint);

  const replacement = { url: "blob:next", colour: "oklch(0.4 0.1 80)" };
  vi.mocked(useArtwork).mockReturnValue(replacement);
  await act(async () =>
    live.publish({ type: "device", id: tv.id, device: { ...tv } }),
  );
  expect(image()?.getAttribute("src")).toBe(replacement.url);
  expect(tint()).toBe(replacement.colour);
});

describe("a light with a button and a temperature sensor", () => {
  it.each([
    ["History", "Brightness", "light"],
    ["Readings", "Temperature", "temperature"],
  ])(
    "moves the %s chart clock only while its tab and window are shown",
    async (page, chart, capability) => {
      vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
      vi.setSystemTime(new Date(2026, 9, 31, 12, 17));
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(
        520,
      );
      const visibility = vi
        .spyOn(document, "visibilityState", "get")
        .mockReturnValue("visible");
      const select = (label: string) =>
        act(async () =>
          dialog()
            .querySelector<HTMLButtonElement>(
              `[role="tab"][aria-label="${label}"]`,
            )!
            .click(),
        );
      const showWindow = (state: DocumentVisibilityState) =>
        act(async () => {
          visibility.mockReturnValue(state);
          document.dispatchEvent(new Event("visibilitychange"));
        });
      const advance = () => act(async () => vi.advanceTimersByTime(3 * 60_000));
      const tick = () =>
        dialog()
          .querySelector(`[aria-label="${chart} over the last 24 hours"]`)!
          .parentElement!.querySelector<HTMLElement>(
            'div[aria-hidden="true"] > span',
          )!.style.left;
      const history = vi.mocked(coreJson);
      const request = history.getMockImplementation()!;
      history.mockImplementation(async (path, init) => {
        const answer = await request(path, init);
        return path.startsWith("/api/history/")
          ? { ...(answer as object), kept: true }
          : answer;
      });
      await open("panel/light");
      await select(page);
      const initial = tick();
      await advance();
      const beforeLeaving = tick();
      expect(beforeLeaving).not.toBe(initial);

      // Keep refresh responses pending so only the clock can move the axis.
      history.mockImplementation((path, init) =>
        path.startsWith("/api/history/")
          ? new Promise(() => {})
          : request(path, init),
      );
      await select("Brightness");
      await showWindow("hidden");
      await advance();
      await showWindow("visible");
      expect(tick()).toBe(beforeLeaving);
      await advance();
      expect(tick()).toBe(beforeLeaving);

      await select(page);
      const beforeHiding = tick();
      expect(beforeHiding).not.toBe(beforeLeaving);
      await showWindow("hidden");
      await advance();
      expect(tick()).toBe(beforeHiding);

      history.mockClear();
      await showWindow("visible");
      expect(tick()).not.toBe(beforeHiding);
      expect(
        history.mock.calls.filter(
          ([path]) =>
            path.startsWith("/api/history/") &&
            path.includes(`capability=${capability}&`),
        ),
      ).toHaveLength(2);
    },
  );

  it.each([
    ["panel/light", "Brightness"],
    ["panel/temperature", "Readings"],
    ["panel/button", "Presses, from Presses"],
  ])(
    "has the same pages from each of its tiles, opening from %s on %s",
    async (tileKey, page) => {
      await open(tileKey);

      expect(dialog().querySelector("h2")?.textContent).toBe("Desk panel");
      expect(dialog().textContent).toContain("Office · 40%");
      expect(tabs()).toEqual(
        [
          "Brightness",
          "Readings",
          "Presses, from Presses",
          "History",
          "Activity",
        ].map((each) => [each, each === page ? "true" : "false"]),
      );
    },
  );

  it("uses the primary light from Readings even when an auxiliary relay is listed first", async () => {
    devices = [
      {
        ...panel,
        capabilities: [
          { ...plug.capabilities[0]!, id: "relay" },
          ...panel.capabilities,
        ],
      },
    ];
    await open("panel/temperature");

    expect(dialog().querySelector("h2")?.textContent).toBe("Desk panel light");
    expect(dialog().textContent).toContain("Office · 40%");
    expect(tabs()).toContainEqual(["Brightness", "false"]);
    expect(tabs()).toContainEqual(["Readings", "true"]);
  });

  it("stays on Readings when a live device update adds another page before it", async () => {
    await open("panel/temperature");
    await act(async () =>
      live.publish({
        type: "device",
        id: panel.id,
        device: {
          ...panel,
          capabilities: [...panel.capabilities, motionCapability(false)],
        },
      }),
    );

    expect(tabs()).toContainEqual(["Motion", "false"]);
    expect(tabs()).toContainEqual(["Readings", "true"]);
  });

  it("opens a button's Activity when no app provides its page", async () => {
    await open("panel/button", { apps: [] });

    expect(tabs()).toContainEqual(["Activity", "true"]);
  });

  it("reveals Presses below the driver's app page when opened from the button", async () => {
    const revealed: string[] = [];
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value(this: Element) {
        revealed.push(this.querySelector("iframe")?.title ?? "");
      },
    });
    try {
      await open("panel/button", { apps: [driver, presses] });

      expect(tabs()).toContainEqual(["From apps", "true"]);
      expect(
        [...dialog().querySelectorAll("iframe")].map((frame) => frame.title),
      ).toEqual(["Example: Status", "Presses: Presses"]);
      expect(revealed).toContain("Presses: Presses");
    } finally {
      Reflect.deleteProperty(Element.prototype, "scrollIntoView");
    }
  });
});

it("starts on the first page from a room even when that tile represents another capability", async () => {
  const contact = contactSensor("door", "Hallway door", "office", false);
  devices = [
    {
      ...contact,
      capabilities: [...contact.capabilities, motionCapability(false)],
    },
  ];
  await open("door/contact");
  expect(tabs()).toContainEqual(["Contact", "true"]);

  await open("door/contact", { openFirstPage: true });
  expect(tabs()).toContainEqual(["Motion", "true"]);
});

describe("a device with two switches", () => {
  it("gives its second switch's tile that switch's own controls and history", async () => {
    await open("relay/2");

    expect(dialog().querySelector("h2")?.textContent).toBe("Relay 2");
    expect(dialog().textContent).toContain("Office · Off");
    expect(tabs()).toEqual([
      ["Power", "true"],
      ["History", "false"],
      ["Activity", "false"],
    ]);
    await act(async () =>
      dialog()
        .querySelector<HTMLButtonElement>('button[aria-label="Relay 2"]')!
        .click(),
    );
    expect(posted()).toEqual([
      { device: "relay", capability: "2", command: { on: true } },
    ]);
  });
});

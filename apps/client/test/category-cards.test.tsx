// @vitest-environment jsdom
import type { DeviceInfo, LightsResult } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { CategoryPage } from "../src/place-pages";
import { useDevices } from "../src/use-devices";
import {
  contactSensor,
  hallLight,
  lamp,
  light,
  loose,
  places,
  plug,
  sensor,
} from "./place-pages-fixtures";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

// What a category's page opens with: Lights' card and its switch, a
// button for each room's lights, Environment's cards and Security's.

let root: Root;
let container: HTMLDivElement;
let live: ReturnType<typeof createLiveFeed>;
let devices: DeviceInfo[];
// The lights the core could not switch, as its answer names them.
let failed: { device: string; capability: string }[];

function Page(props: { id: string }) {
  const shown = useDevices(live);
  return (
    <CategoryPage
      id={props.id}
      devices={shown}
      openDevice={() => undefined}
      openRoom={() => undefined}
      back={() => undefined}
    />
  );
}

async function show(id: string) {
  await act(async () => {
    root.render(<Page id={id} />);
  });
  await act(async () => {
    live.refresh();
  });
}

const cards = () =>
  [...container.querySelectorAll("ul[role=list] > li")] as HTMLElement[];
const card = () => cards()[0] ?? null;
// Lights' card: the home's, with its switch (lights-card.tsx).
const lightsCard = () =>
  container.querySelector<HTMLElement>('[role=group][aria-label="Lights"]');
// What its left segment says: "Lights" and how many are on.
const lightsSaid = (each: HTMLElement) =>
  [
    ...each.querySelectorAll(
      ":scope > :first-child > span > span:not(.sr-only)",
    ),
  ].map((line) => line.textContent);
// What a card says, as it shows it: its name, its status and its note.
const said = (each: HTMLElement) =>
  [...each.querySelectorAll(":scope > span > span:not(.sr-only)")].map(
    (line) => line.textContent,
  );
const button = (label: string) =>
  [...container.querySelectorAll("button")].find(
    (each) => each.getAttribute("aria-label") === label,
  ) as HTMLButtonElement | undefined;
const posted = (path: string) =>
  vi
    .mocked(coreJson)
    .mock.calls.filter(([each]) => each === path)
    .map(([, init]) => init?.json);
const offline = (device: DeviceInfo): DeviceInfo => ({
  ...device,
  availability: "offline",
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolveValue) => {
    resolve = resolveValue;
  });
  return { promise, resolve };
}

async function click(element: HTMLElement | null | undefined) {
  if (!element) throw new Error("Nothing to click");
  await act(async () => {
    element.click();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  live = createLiveFeed();
  devices = [lamp, plug, hallLight, loose];
  failed = [];
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path === "/api/devices") return devices;
    if (path === "/api/places") return places;
    if (path === "/api/devices/lights") {
      return { on: false, switched: 1, failed };
    }
    throw new Error(`Unexpected ${path}`);
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Lights' card", () => {
  it("says how many are on, with a switch that turns the home's lights off", async () => {
    await show("lights");

    expect(lightsSaid(lightsCard()!)).toEqual(["Lights", "1 on"]);
    expect(
      lightsCard()!
        .querySelector("svg")
        ?.classList.contains("lucide-lightbulb"),
    ).toBe(true);
    const off = lightsCard()!.querySelector("button");
    // The power symbol alone, White while any is on, its words its tooltip.
    expect(off?.textContent).toBe("");
    expect(off?.getAttribute("aria-label")).toBe("Turn off 1 light");
    expect(off?.title).toBe("Turn off 1 light");
    expect(off?.dataset.on).toBe("");
    // What it did is said where a screen reader already listens.
    const did = lightsCard()!.querySelector("[role=status]");
    expect(did?.textContent).toBe("");
    await click(off);
    expect(posted("/api/devices/lights")).toEqual([
      { place: { kind: "home" }, to: "off" },
    ]);
    expect(lightsCard()!.querySelector("[role=status]")).toBe(did);
    expect(did?.textContent).toBe("Lights turned off");
  });

  it("says which lights did not turn off, and stops saying what it did after a while", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    failed = [{ device: "lamp", capability: "light" }];
    await show("lights");
    await click(lightsCard()!.querySelector("button"));
    const did = lightsCard()!.querySelector("[role=status]");
    expect(did?.textContent).toBe("1 light did not turn off");
    // The light that stayed on is back on the card, its switch White.
    expect(lightsSaid(lightsCard()!)).toEqual(["Lights", "1 on"]);
    expect(lightsCard()!.querySelector("button")?.disabled).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(9_000);
    });
    expect(did?.textContent).toBe("1 light did not turn off");
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(did?.textContent).toBe("");
  });

  it("says each press's own answer", async () => {
    failed = [{ device: "lamp", capability: "light" }];
    await show("lights");
    await click(lightsCard()!.querySelector("button"));
    const did = lightsCard()!.querySelector("[role=status]");
    expect(did?.textContent).toBe("1 light did not turn off");

    failed = [];
    await click(lightsCard()!.querySelector("button"));
    expect(did?.textContent).toBe("Lights turned off");
  });

  it("keeps the newest answer when an earlier press finishes late", async () => {
    const first = deferred<LightsResult>();
    const second = deferred<LightsResult>();
    const responses = [first.promise, second.promise];
    const coreAnswers = vi.mocked(coreJson).getMockImplementation()!;
    vi.mocked(coreJson).mockImplementation((path, init) =>
      path === "/api/devices/lights"
        ? responses.shift()!
        : coreAnswers(path, init),
    );
    await show("lights");
    const off = lightsCard()!.querySelector("button");
    const did = lightsCard()!.querySelector("[role=status]");
    await click(off);

    // Another light comes on while the first press is still pending.
    devices = [lamp, light(hallLight.id, hallLight.name, "hall", true)];
    await act(async () => live.refresh());
    expect(off?.disabled).toBe(false);
    await click(off);

    await act(async () => {
      second.resolve({ on: false, switched: 1, failed: [] });
    });
    expect(did?.textContent).toBe("Lights turned off");

    await act(async () => {
      first.resolve({
        on: false,
        switched: 0,
        failed: [{ device: lamp.id, capability: "light" }],
      });
    });
    expect(did?.textContent).toBe("Lights turned off");
  });

  it("keeps its switch, disabled, while every light is off: the home's lights are never all turned on", async () => {
    devices = [hallLight, loose];
    await show("lights");

    expect(lightsSaid(lightsCard()!)).toEqual(["Lights", "All off"]);
    const off = lightsCard()!.querySelector("button");
    expect(off?.disabled).toBe(true);
    expect(off?.dataset.on).toBeUndefined();
    expect(off?.getAttribute("aria-label")).toBe("Turn off lights");
  });

  it("counts reachable lights, and says how many are offline rather than All off", async () => {
    devices = [lamp, offline(hallLight)];
    await show("lights");
    expect(lightsSaid(lightsCard()!)).toEqual(["Lights", "1 on"]);

    // The lamp that does not answer may still be on.
    devices = [hallLight, offline(lamp)];
    await act(async () => {
      live.refresh();
    });
    expect(lightsSaid(lightsCard()!)).toEqual(["Lights", "1 offline"]);

    devices = [offline(lamp), offline(hallLight)];
    await act(async () => {
      live.refresh();
    });
    expect(lightsSaid(lightsCard()!)).toEqual(["Lights", "Offline"]);
    expect(lightsCard()!.querySelector("button")?.disabled).toBe(true);
  });
});

describe("a room's lights on Lights' page", () => {
  it("have the room's lights button over them, which says what it does", async () => {
    await show("lights");

    const office = button("Turn off lights in Office")!;
    expect(office.textContent).toBe("Turn off lights");
    expect(office.querySelector("svg.lucide-power")).not.toBeNull();
    expect(office.dataset.on).toBe("");
    expect(office.dataset.size).toBe("chip");
    expect(office.classList.contains("self-start")).toBe(true);
    expect(office.hasAttribute("aria-pressed")).toBe(false);
    // Between the room's heading and its lights' tiles.
    const section = office.closest("section")!;
    expect(section.querySelector("h2, h3")?.nextElementSibling).toBe(office);
    expect(office.nextElementSibling?.matches(".tile-grid")).toBe(true);
    const hall = button("Turn on lights in Hall")!;
    expect(hall.textContent).toBe("Turn on lights");
    expect(hall.dataset.on).toBeUndefined();

    await click(office);
    await click(hall);
    expect(posted("/api/devices/lights")).toEqual([
      { place: { kind: "room", id: "office" }, to: "off" },
      { place: { kind: "room", id: "hall" }, to: "on" },
    ]);
  });

  it("have none in no room, whose lights are not together", async () => {
    await show("lights");
    expect(
      [...container.querySelectorAll("button")]
        .map((each) => each.getAttribute("aria-label"))
        .filter((label) => label?.startsWith("Turn")),
    ).toEqual([
      // The home's, on Lights' card.
      "Turn off 1 light",
      "Turn off lights in Office",
      "Turn on lights in Hall",
    ]);
  });

  it("are on no other category's page", async () => {
    await show("switches");
    expect(button("Turn off lights in Office")).toBeUndefined();
  });
});

describe("Environment's cards", () => {
  it("range each reading across the home, and are never White", async () => {
    devices = [
      sensor("desk", "office", 21.5, 48),
      sensor("hall", "hall", 19.5, 58),
    ];
    await show("environment");

    expect(cards().map(said)).toEqual([
      ["Temperature", "19.5–21.5°"],
      ["Humidity", "48–58%"],
    ]);
    // A screen reader hears the range in words.
    expect(card()!.querySelector(".sr-only")?.textContent).toBe(
      ", 19.5 to 21.5°",
    );
    expect(cards().map((each) => each.dataset.active)).toEqual([
      undefined,
      undefined,
    ]);
    expect(cards().some((each) => each.querySelector("button"))).toBe(false);
    // Nothing sums them up under the page's name any more.
    expect(container.querySelector("header p")).toBeNull();
  });

  it("say how many sensors are not known, and when none reads", async () => {
    devices = [
      sensor("desk", "office", 21.5, 48),
      offline(sensor("hall", "hall", 19.5, 58)),
    ];
    await show("environment");
    expect(cards().map(said)).toEqual([
      ["Temperature", "21.5°", "1 not known"],
      ["Humidity", "48%", "1 not known"],
    ]);

    devices = [offline(sensor("hall", "hall", 19.5, 58))];
    await act(async () => {
      live.refresh();
    });
    expect(cards().map(said)).toEqual([
      ["Temperature", "No readings"],
      ["Humidity", "No readings"],
    ]);
  });
});

describe("Security's card", () => {
  it("is White and says how many are open, and how many are not known", async () => {
    devices = [
      contactSensor("front", "Front door", "hall", true),
      contactSensor("letterbox", "Letterbox", "hall", false),
      contactSensor("window", "Window", "office", null),
    ];
    await show("security");

    expect(card()!.textContent).toBe("Contact sensors, 1 open, 1 not known");
    expect(card()!.dataset.active).toBe("");
    // It only tells: it is no button and holds none.
    expect(card()!.querySelector("button, a")).toBeNull();
    expect(
      card()!.querySelector("svg")?.classList.contains("lucide-contact-open"),
    ).toBe(true);
  });

  it("is one for the doors, one for the windows and one for the sensors shown as neither, each only where the home has one", async () => {
    const as = (device: DeviceInfo, type: "door" | "window"): DeviceInfo => ({
      ...device,
      type,
      shownAs: type,
    });
    devices = [
      as(contactSensor("front", "Front door", "hall", true), "door"),
      as(contactSensor("back", "Back door", "hall", false), "door"),
      as(contactSensor("kitchen", "Kitchen window", "office", false), "window"),
      contactSensor("letterbox", "Letterbox", "hall", null),
    ];
    await show("security");

    expect(cards().map((each) => each.textContent)).toEqual([
      "Doors, 1 open",
      "Windows, All closed",
      "Contact sensors, No readings",
    ]);
    // Only the doors' is White, and each has its own glyph, open or closed.
    expect(cards().map((each) => each.dataset.active)).toEqual([
      "",
      undefined,
      undefined,
    ]);
    const glyphs = ["door-open", "window-closed", "contact-closed"];
    expect(
      cards().map((each, index) =>
        each
          .querySelector("svg")!
          .classList.contains(`lucide-${glyphs[index]}`),
      ),
    ).toEqual([true, true, true]);

    devices = devices.slice(0, 2);
    await show("security");
    expect(cards().map((each) => each.textContent)).toEqual(["Doors, 1 open"]);
  });

  it("is frosted glass and says All closed once every contact sensor has said so", async () => {
    devices = [
      contactSensor("front", "Front door", "hall", false),
      contactSensor("letterbox", "Letterbox", "hall", false),
    ];
    await show("security");

    expect(card()!.textContent).toBe("Contact sensors, All closed");
    expect(card()!.dataset.active).toBeUndefined();
    expect(
      card()!.querySelector("svg")?.classList.contains("lucide-contact-closed"),
    ).toBe(true);
  });

  it("follows the sensors live", async () => {
    devices = [contactSensor("front", "Front door", "hall", false)];
    await show("security");
    expect(card()!.textContent).toBe("Contact sensors, All closed");

    await act(async () => {
      live.publish({
        type: "device",
        id: "front",
        device: contactSensor("front", "Front door", "hall", true),
      });
    });
    expect(card()!.textContent).toBe("Contact sensors, 1 open");
    expect(card()!.dataset.active).toBe("");
  });
});

describe("Switches' page", () => {
  it("has no card: it keeps the line under its name", async () => {
    await show("switches");
    expect(cards()).toEqual([]);
    expect(container.querySelector("header p")?.textContent).toBe("1 on");
  });
});

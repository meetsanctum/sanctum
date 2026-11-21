// @vitest-environment jsdom
import type { AppInfo, DeviceInfo, EntityInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import { HomeRooms } from "../src/home-dashboard";
import { RoomPage } from "../src/place-pages";
import { useSectionEntities } from "../src/room-sections";
import { useDevices } from "../src/use-devices";
import {
  entity,
  hallLight,
  lamp,
  moods,
  places,
  relax,
} from "./place-pages-fixtures";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

// A room's row: its switch, then apps' buttons, squares with their icon
// alone, then apps' tiles with their names, on its page and on Home, with
// no heading.

const glow: AppInfo = {
  ...moods,
  id: "sanctum.example",
  name: "Example",
  provides: {
    ...moods.provides,
    roomSections: [
      {
        id: "example.room",
        title: "Glow",
        entityType: "example.glow",
        kind: "buttons",
        order: 300,
        press: { action: "example.toggle" },
      },
    ],
  },
};
const officeGlow = entity("sanctum.example", "example.glow", "office", {
  placeId: "office",
  name: "Glow",
  icon: "sun",
  active: true,
  input: { placeId: "office" },
});
const hallGlow = entity("sanctum.example", "example.glow", "hall", {
  placeId: "hall",
  name: "Glow",
  icon: "sun",
  active: false,
  input: { placeId: "hall" },
});

let root: Root;
let container: HTMLDivElement;
let live: ReturnType<typeof createLiveFeed>;
let devices: DeviceInfo[];
let entities: EntityInfo[];

function Harness(props: { page: "room" | "home"; apps: AppInfo[] }) {
  const shown = useDevices(live);
  const sectionEntities = useSectionEntities(live, props.apps, shown.fail);
  return props.page === "room" ? (
    <RoomPage
      roomId="office"
      devices={shown}
      apps={props.apps}
      entities={sectionEntities}
      openDevice={() => {}}
      back={() => {}}
    />
  ) : (
    <HomeRooms
      devices={shown}
      onHome={[]}
      homeName="Home"
      apps={props.apps}
      entities={sectionEntities}
      openRoom={() => {}}
      openNoRoom={() => {}}
      openDevice={() => {}}
      onEdit={() => {}}
    />
  );
}

async function show(page: "room" | "home", apps: AppInfo[] = [moods, glow]) {
  await act(async () => {
    root.render(<Harness page={page} apps={apps} />);
  });
  await act(async () => {
    live.refresh();
  });
}

const buttons = () =>
  [...container.querySelectorAll("button")] as HTMLButtonElement[];
const named = (label: string) =>
  buttons().find((each) => each.getAttribute("aria-label") === label);
// A room's row, by what each of its tiles says.
const rowOf = (room: string) =>
  [
    ...(container
      .querySelector(`[role=group][aria-label='Lights in ${room}']`)
      ?.querySelectorAll("button") ?? []),
  ].map((each) => each.getAttribute("aria-label") ?? each.textContent);
const posted = (path: string) =>
  vi
    .mocked(coreJson)
    .mock.calls.filter(([each]) => each === path)
    .map(([, init]) => init?.json);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  live = createLiveFeed();
  devices = [lamp, hallLight];
  entities = [relax, officeGlow, hallGlow];
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (path === "/api/devices") return devices;
    if (path === "/api/places") return places;
    if (path.startsWith("/api/entities?")) {
      const query = new URLSearchParams(path.split("?")[1]);
      return entities.filter(
        (each) =>
          each.app === query.get("app") && each.type === query.get("type"),
      );
    }
    return { switched: 1, failed: [] };
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
  vi.unstubAllGlobals();
});

describe("a room's row", () => {
  it("has the lights button and apps' buttons as chips, then their tiles, with no heading", async () => {
    await show("room");
    expect(rowOf("Office")).toEqual([
      "Turn off lights in Office",
      "Glow in Office",
      "Relax in Office",
    ]);
    // A chip shows its name, and adds the room for a screen reader.
    expect(named("Glow in Office")?.textContent).toBe("Glow");
    expect(named("Glow in Office")?.getAttribute("aria-pressed")).toBe("true");
    expect(
      [...container.querySelectorAll("h2")].map((each) => each.textContent),
    ).toEqual(["Lights"]);
  });

  it("lights one look at most, a button before a tile that says it is active too", async () => {
    // Relax says it is active as well: its lights happen to show Glow's look.
    await show("room");
    expect(named("Glow in Office")?.getAttribute("aria-pressed")).toBe("true");
    expect(named("Relax in Office")?.getAttribute("aria-pressed")).toBe(
      "false",
    );
    entities = [
      relax,
      {
        ...officeGlow,
        state: { ...(officeGlow.state as object), active: false },
      },
    ];
    await show("room");
    expect(named("Relax in Office")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("puts its chips on a line of their own, the lights button first, over its tiles", async () => {
    await show("room");
    const chips = named("Glow in Office")!.parentElement!;
    expect(chips.className).toContain("flex-wrap");
    expect(chips.firstElementChild?.getAttribute("aria-label")).toBe(
      "Turn off lights in Office",
    );
    expect(chips.nextElementSibling?.matches(".tile-grid")).toBe(true);
    expect(chips.nextElementSibling?.contains(named("Relax in Office")!)).toBe(
      true,
    );
  });

  it("calls the section's action with the square's input on a tap", async () => {
    await show("room");
    await act(async () => {
      named("Glow in Office")!.click();
    });
    expect(posted("/api/apps/sanctum.example/actions/example.toggle")).toEqual([
      { placeId: "office" },
    ]);
  });

  it("shows a tap that failed on the square", async () => {
    const animate = vi.fn();
    Element.prototype.animate = animate;
    try {
      await show("room");
      vi.mocked(coreJson).mockImplementationOnce(async () => {
        throw new Error("unavailable");
      });
      await act(async () => {
        named("Glow in Office")!.click();
      });
      expect(animate.mock.contexts).toContain(named("Glow in Office"));
    } finally {
      delete (Element.prototype as Partial<Element>).animate;
    }
  });

  it("is under each room's name on Home, as on its page", async () => {
    await show("home");
    expect(named("Glow in Office")?.getAttribute("aria-pressed")).toBe("true");
    expect(named("Glow in Hall")?.getAttribute("aria-pressed")).toBe("false");
    expect(rowOf("Office")).toEqual([
      "Turn off lights in Office",
      "Glow in Office",
      "Relax in Office",
    ]);
    expect(rowOf("Hall")).toEqual(["Turn on lights in Hall", "Glow in Hall"]);
  });

  it("shows a room on Home that has nothing else to show", async () => {
    devices = [];
    entities = [hallGlow];
    await show("home");
    expect(
      [...container.querySelectorAll("h2")].map((each) => each.textContent),
    ).toEqual(["Hall"]);
    expect(named("Glow in Hall")).toBeDefined();
  });

  it("dims a paused square and gives the highlight to the running app", async () => {
    await show("room", [moods, { ...glow, state: "paused" }]);
    const paused = named("Glow in Office, paused");
    const mood = named("Relax in Office");
    expect(paused?.disabled).toBe(true);
    expect(paused?.getAttribute("aria-pressed")).toBe("false");
    expect(mood?.disabled).toBe(false);
    expect(mood?.getAttribute("aria-pressed")).toBe("true");
  });

  it("leaves out an app's squares once it is turned off", async () => {
    await show("room", [moods, { ...glow, state: "off" }]);
    expect(rowOf("Office")).toEqual([
      "Turn off lights in Office",
      "Relax in Office",
    ]);
  });
});

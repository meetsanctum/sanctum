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

// Room sections of buttons: an app's small buttons for a room, after the
// room's button for all its lights, on its page and on Home, with no
// heading.

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
        open: null,
        whenEmpty: null,
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
      openApp={() => {}}
      canOpen={() => true}
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

describe("a room's buttons", () => {
  it("follow the room's lights button on its page, pressed while active, with no heading", async () => {
    await show("room");
    const header = container.querySelector("header")!;
    expect(
      [...header.querySelectorAll("button")].map(
        (each) => each.getAttribute("aria-label") ?? each.textContent,
      ),
    ).toEqual(["Turn off 1 light in Office", "Glow in Office"]);
    expect(named("Glow in Office")?.textContent).toBe("Glow");
    expect(named("Glow in Office")?.getAttribute("aria-pressed")).toBe("true");
    expect(
      [...container.querySelectorAll("h2")].map((each) => each.textContent),
    ).toEqual(["Moods", "Lights"]);
  });

  it("call the section's action with the button's input on a tap", async () => {
    await show("room");
    await act(async () => {
      named("Glow in Office")!.click();
    });
    expect(posted("/api/apps/sanctum.example/actions/example.toggle")).toEqual([
      { placeId: "office" },
    ]);
  });

  it("show a tap that failed on the button", async () => {
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

  it("are on each room's line on Home, after its lights button", async () => {
    await show("home");
    expect(named("Glow in Office")?.getAttribute("aria-pressed")).toBe("true");
    expect(named("Glow in Hall")?.getAttribute("aria-pressed")).toBe("false");
    const office = named("Glow in Office")!.parentElement!;
    expect(
      [...office.querySelectorAll("button")].map((each) =>
        each.getAttribute("aria-label"),
      ),
    ).toEqual(["Turn off 1 light in Office", "Glow in Office"]);
  });

  it("show a room on Home that has nothing else to show", async () => {
    devices = [];
    entities = [hallGlow];
    await show("home");
    expect(
      [...container.querySelectorAll("h2")].map((each) => each.textContent),
    ).toEqual(["Hall"]);
    expect(named("Glow in Hall")).toBeDefined();
  });

  it("dim while their app isn't running, and say so", async () => {
    await show("room", [moods, { ...glow, state: "paused" }]);
    expect(named("Glow in Office, paused")?.disabled).toBe(true);
  });

  it("leave when their app is turned off", async () => {
    await show("room", [moods, { ...glow, state: "off" }]);
    expect(buttons().some((each) => each.textContent === "Glow")).toBe(false);
  });
});

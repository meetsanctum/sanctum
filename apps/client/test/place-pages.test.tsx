// @vitest-environment jsdom
import type { AppInfo, DeviceInfo, EntityInfo } from "@meetsanctum/app-sdk";
import { createLiveFeed } from "@meetsanctum/ui-sdk";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { coreJson } from "../src/core-fetch";
import {
  CategoryPage,
  NoRoomPage,
  noRoomPage,
  RoomPage,
  SidebarPlaces,
} from "../src/place-pages";
import { useSectionEntities } from "../src/room-sections";
import { useDevices } from "../src/use-devices";
import {
  alarms,
  awnings,
  contactSensor,
  entity,
  hallLight,
  lamp,
  loose,
  moods,
  places,
  plug,
  relax,
  sensor,
  spots,
  work,
} from "./place-pages-fixtures";

vi.mock("../src/core-fetch", () => ({ coreJson: vi.fn() }));

// Room and category pages, the shell's: a room's row of its switch and apps'
// tiles drawn from their entities, a button for all the lights on a
// category's page, and the devices by category or room.

let root: Root;
let container: HTMLDivElement;
let live: ReturnType<typeof createLiveFeed>;
let devices: DeviceInfo[];
let entities: EntityInfo[];
let answers: Record<string, () => Promise<unknown>>;
const openDevice = vi.fn();
const openPlace = vi.fn();
const back = vi.fn();

function Harness(props: {
  page: "room" | "category" | typeof noRoomPage;
  id: string;
  apps: AppInfo[];
}) {
  const shown = useDevices(live);
  const sectionEntities = useSectionEntities(live, props.apps, shown.fail);
  return props.page === "room" ? (
    <RoomPage
      roomId={props.id}
      devices={shown}
      apps={props.apps}
      entities={sectionEntities}
      openDevice={openDevice}
      back={back}
    />
  ) : props.page === noRoomPage ? (
    <>
      <main>
        <NoRoomPage devices={shown} openDevice={openDevice} back={back} />
      </main>
      <nav>
        <SidebarPlaces
          devices={shown}
          current={{ page: noRoomPage, params: {} }}
          open={openPlace}
        />
      </nav>
    </>
  ) : (
    <>
      <CategoryPage
        id={props.id}
        devices={shown}
        openDevice={openDevice}
        openRoom={() => {}}
        back={back}
      />
      <nav>
        <SidebarPlaces
          devices={shown}
          current={{ page: "category", params: { id: props.id } }}
          open={() => {}}
        />
      </nav>
    </>
  );
}

async function show(
  page: "room" | "category" | typeof noRoomPage,
  id = "",
  apps: AppInfo[] = [moods],
) {
  await act(async () => {
    root.render(<Harness page={page} id={id} apps={apps} />);
  });
  await act(async () => {
    live.refresh();
  });
}

const button = (text: string) =>
  [...container.querySelectorAll("main button, button")].find(
    (each) =>
      each.textContent === text || each.getAttribute("aria-label") === text,
  ) as HTMLButtonElement | undefined;
// The tiles of a room's row, by what they say.
const row = () =>
  [
    ...(container
      .querySelector("[role=group][aria-label^='Looks in']")
      ?.querySelectorAll("button") ?? []),
  ].map((each) => each.getAttribute("aria-label") ?? each.textContent);
// A tile, by the name it starts with.
const tile = (name: string) =>
  [...container.querySelectorAll("button")].find((each) =>
    each.textContent?.startsWith(name),
  ) as HTMLButtonElement | undefined;
const headings = () =>
  [...container.querySelectorAll("main h2, h2")].map(
    (each) => each.textContent,
  );
const posted = (path: string) =>
  vi
    .mocked(coreJson)
    .mock.calls.filter(([each]) => each === path)
    .map(([, init]) => init?.json);

async function click(element: HTMLElement | undefined) {
  if (!element) throw new Error("Nothing to click");
  await act(async () => {
    element.click();
  });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  live = createLiveFeed();
  devices = [lamp, plug, hallLight, loose];
  entities = [relax, work];
  answers = {};
  openDevice.mockReset();
  openPlace.mockReset();
  back.mockReset();
  vi.mocked(coreJson).mockReset();
  vi.mocked(coreJson).mockImplementation(async (path) => {
    if (answers[path]) return answers[path]();
    if (path === "/api/devices") return devices;
    if (path === "/api/places") return places;
    if (path.startsWith("/api/entities?")) {
      const query = new URLSearchParams(path.split("?")[1]);
      return entities.filter(
        (each) =>
          each.app === query.get("app") && each.type === query.get("type"),
      );
    }
    if (path === "/api/devices/lights") {
      return { on: false, switched: 1, failed: [] };
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

describe("all the lights of a room", () => {
  it("does not describe remote presses as on or off in the Buttons header", async () => {
    devices = [
      {
        ...lamp,
        id: "remote",
        name: "Remote",
        type: "button",
        capabilities: [
          {
            id: "button",
            kind: "button",
            features: { actions: ["single"], holds: [] },
            state: null,
            observed: null,
            desired: null,
            sync: "synced",
            setBy: null,
            changedAt: null,
          },
        ],
      },
    ];
    await show("category", "buttons");
    expect(container.querySelector("header")?.textContent).toBe("Buttons");
    expect(
      container.querySelector("nav [aria-current=page]")?.textContent,
    ).toBe("Buttons");
    await act(async () => {
      live.publish({
        type: "press",
        device: "remote",
        capability: "button",
        action: "single",
        at: new Date().toISOString(),
        isCaptured: false,
      });
    });
    expect(container.querySelector("header")?.textContent).toBe("Buttons");
    expect(
      container.querySelector("nav [aria-current=page]")?.textContent,
    ).toBe("Buttons");
  });

  it("of a room, by its Lights tile first among its lights, through the core", async () => {
    await show("room", "office");
    const lights = button("Lights in Office, 40%")!;
    // A light's tile with the power symbol, lit at its lights' level.
    expect(lights.textContent).toBe("Lights40%");
    expect(lights.dataset.look).toBe("lit");
    expect(lights.parentElement?.parentElement?.firstElementChild).toBe(
      lights.parentElement,
    );
    const icon = button("Lights in Office")!;
    expect(icon.querySelector("svg.lucide-power")).not.toBeNull();
    expect(icon.getAttribute("aria-pressed")).toBe("true");
    await click(icon);
    expect(posted("/api/devices/lights")).toEqual([
      { place: { kind: "room", id: "office" }, to: "off" },
    ]);
  });

  it("cannot be switched while they are all offline", async () => {
    devices = [{ ...lamp, availability: "offline" }];
    await show("room", "office");
    expect(button("Lights in Office, Offline")).toBeDefined();
    expect(button("Lights in Office")?.disabled).toBe(true);
    // Nothing a mood sets could answer either.
    expect(tile("Relax")?.disabled).toBe(true);
  });
});

describe("a category's page", () => {
  it("shows its tiles by room, devices with no room last, and the sidebar marks it", async () => {
    await show("category", "lights");
    expect(container.querySelector("h1")?.textContent).toBe("Lights");
    expect(headings()).toEqual([
      "Office",
      "Hall",
      "No room",
      "Categories",
      "Rooms",
    ]);
    const current = container.querySelector("nav [aria-current=page]");
    expect(current?.textContent).toBe("Lights1 on");
    expect(current?.getAttribute("aria-label")).toBe("Lights, 1 on");
    expect(
      [...container.querySelectorAll("nav button")].map(
        (each) => each.textContent,
      ),
    ).toEqual([
      "Lights1 on",
      "Switches1 on",
      "Office",
      "Hall",
      "Attic",
      "No room",
    ]);
  });

  it("is not in the sidebar while the home has none of its devices", async () => {
    devices = [lamp];
    await show("category", "lights");
    expect(
      [...container.querySelectorAll("nav button")].map(
        (each) => each.textContent,
      ),
    ).toEqual(["Lights1 on", "Office", "Hall", "Attic"]);
  });
});

describe("the devices in no room", () => {
  const sidebar = () =>
    [...container.querySelectorAll("nav button")].map(
      (each) => each.textContent,
    );

  it("have a page like a room's, their tiles by category under its name alone", async () => {
    devices = [
      lamp,
      loose,
      { ...plug, id: "spare", name: "Spare", roomId: null },
    ];
    await show(noRoomPage);
    expect(container.querySelector("h1")?.textContent).toBe("No room");
    expect(
      [...container.querySelectorAll("main h2")].map(
        (each) => each.textContent,
      ),
    ).toEqual(["Lights", "Switches"]);
    expect(tile("Loose")).toBeDefined();
    expect(tile("Spare")).toBeDefined();
    // Another room's devices are not among them.
    expect(
      [...container.querySelectorAll("main button")].map(
        (each) => each.textContent,
      ),
    ).not.toContain(tile("Lamp")?.textContent);
    // Its devices are not together, so no button switches all its lights.
    expect(button("Turn on")).toBeUndefined();
    expect(button("Turn on lights in No room")).toBeUndefined();

    await click(tile("Loose"));
    expect(openDevice).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "loose" }),
    );
  });

  it("include a device Sanctum cannot use, last, under no category", async () => {
    const purifier: DeviceInfo = {
      ...loose,
      id: "purifier",
      name: "Unknown device",
      driverName: "STARKVIND air purifier",
      type: "unknown",
      capabilities: [],
    };
    devices = [lamp, loose, purifier];
    await show(noRoomPage);
    expect(
      [...container.querySelectorAll("main h2")].map(
        (each) => each.textContent,
      ),
    ).toEqual(["Lights", "Unknown devices"]);
    expect(tile("Unknown device")?.textContent).toBe(
      "Unknown deviceSTARKVIND air purifier",
    );
    // No category holds it, so the sidebar's categories are as they were.
    expect(sidebar()).toEqual([
      "Lights1 on",
      "Office",
      "Hall",
      "Attic",
      "No room",
    ]);

    await click(tile("Unknown device"));
    expect(openDevice).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: "purifier", kind: "unknown" }),
    );

    // By itself it keeps the entry and the page.
    devices = [lamp, purifier];
    await show(noRoomPage);
    expect(sidebar()).toContain("No room");
    expect(container.querySelector("h1")?.textContent).toBe("No room");
  });

  it("are last among the sidebar's rooms, and marked while their page shows", async () => {
    await show(noRoomPage);
    expect(sidebar()).toEqual([
      "Lights1 on",
      "Switches1 on",
      "Office",
      "Hall",
      "Attic",
      "No room",
    ]);
    expect(
      container.querySelector("nav [aria-current=page]")?.textContent,
    ).toBe("No room");

    await click(button("No room"));
    expect(openPlace).toHaveBeenCalledWith(noRoomPage, {});
  });

  it("are the only entry under Rooms in a home with no rooms yet", async () => {
    answers["/api/places"] = async () => ({ ...places, rooms: [] });
    devices = [loose];
    await show(noRoomPage);
    expect(headings()).toEqual(["Lights", "Categories", "Rooms"]);
    expect(sidebar()).toEqual(["LightsAll off", "No room"]);
  });

  it("leave the sidebar and their page once each has a room", async () => {
    await show(noRoomPage);
    expect(back).not.toHaveBeenCalled();

    await act(async () => {
      live.publish({
        type: "device",
        id: "loose",
        device: { ...loose, roomId: "hall" },
      });
    });
    expect(sidebar()).toEqual([
      "Lights1 on",
      "Switches1 on",
      "Office",
      "Hall",
      "Attic",
    ]);
    expect(container.querySelector("main")?.textContent).toBe("");
    expect(back).toHaveBeenCalledOnce();
  });

  it("do not leave their page before the home's devices are read", async () => {
    let answer!: (devices: DeviceInfo[]) => void;
    answers["/api/devices"] = () =>
      new Promise((resolve) => {
        answer = resolve;
      });
    await show(noRoomPage);
    expect(back).not.toHaveBeenCalled();

    await act(async () => {
      answer([loose]);
    });
    expect(back).not.toHaveBeenCalled();
    expect(container.querySelector("h1")?.textContent).toBe("No room");
  });
});

describe("a room's page", () => {
  it("ends with the devices Sanctum cannot use, after its categories", async () => {
    devices = [
      lamp,
      plug,
      {
        ...lamp,
        id: "purifier",
        name: "Unknown device",
        driverName: "STARKVIND air purifier",
        type: "unknown",
        capabilities: [],
      },
    ];
    await show("room", "office", []);
    expect(headings()).toEqual(["Lights", "Switches", "Unknown devices"]);
    expect(tile("Unknown device")?.textContent).toBe(
      "Unknown deviceSTARKVIND air purifier",
    );
  });

  it("has apps' tiles by weight and app id, and no headings but its devices'", async () => {
    entities = [
      relax,
      entity("test.spots", "spots.spot", "desk", {
        placeId: "office",
        name: "Desk",
      }),
      entity("test.alarms", "alarms.alarm", "door", {
        placeId: "office",
        name: "Door",
      }),
      entity("test.awnings", "awnings.awning", "south", {
        placeId: "office",
        name: "South",
      }),
    ];
    await show("room", "office", [awnings, spots, moods, alarms]);
    expect(row()).toEqual([
      "Relax in Office",
      "Desk in Office",
      "Door in Office",
      "South in Office",
    ]);
    expect(headings()).toEqual(["Lights", "Switches"]);
    // Nothing on the page opens an app to edit its tiles.
    expect(button("Edit")).toBeUndefined();
  });

  it("shows a room's moods in their order, the active one pressed, and runs one on a tap", async () => {
    await show("room", "office");
    expect(row()).toEqual(["Relax in Office", "Work in Office"]);
    expect(tile("Relax")?.getAttribute("aria-pressed")).toBe("true");
    expect(tile("Work")?.getAttribute("aria-pressed")).toBe("false");

    await click(tile("Work"));
    expect(posted("/api/apps/sanctum.moods/actions/moods.runMood")).toEqual([
      { id: "work" },
    ]);
  });

  it("follows the app's entities live, in the room only", async () => {
    await show("room", "office");
    await act(async () => {
      live.publish({
        type: "entity",
        app: "sanctum.moods",
        key: "work",
        entity: {
          ...work,
          state: { ...(work.state as object), active: true, order: 0 },
        },
        was: "mood",
      });
      live.publish({
        type: "entity",
        app: "sanctum.moods",
        key: "relax",
        entity: null,
        was: "mood",
      });
      live.publish({
        type: "entity",
        app: "sanctum.moods",
        key: "bright",
        entity: entity("sanctum.moods", "mood", "bright", {
          placeId: "hall",
          name: "Bright",
        }),
        was: null,
      });
    });
    expect(tile("Relax")).toBeUndefined();
    expect(tile("Bright")).toBeUndefined();
    expect(tile("Work")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("has no row but its Lights tile in a room with lights but no moods", async () => {
    entities = [];
    await show("room", "hall");
    expect(row()).toEqual([]);
    expect(button("Lights in Hall, Off")).toBeDefined();
    expect(headings()).toEqual(["Lights"]);
  });

  it("has no row in a room without lights or moods", async () => {
    await show("room", "attic");
    expect(row()).toEqual([]);
    expect(headings()).toEqual([]);
  });

  it("shows a failed tap on the tile, and the lights a run could not set on theirs", async () => {
    const animate = vi.fn();
    Element.prototype.animate = animate;
    try {
      await show("room", "office");
      answers["/api/apps/sanctum.moods/actions/moods.runMood"] = async () => ({
        switched: 0,
        failed: [{ device: "lamp", capability: "light" }],
      });
      await click(tile("Work"));
      const failed = () =>
        (
          animate.mock.contexts.filter(
            (element) => element instanceof HTMLButtonElement,
          ) as HTMLButtonElement[]
        ).map((each) => each.textContent?.slice(0, 4));
      expect(failed()).toEqual(["Lamp"]);

      answers["/api/apps/sanctum.moods/actions/moods.runMood"] = async () => {
        throw new Error("unavailable");
      };
      await click(tile("Relax"));
      expect(failed()).toEqual(["Lamp", "Rela"]);
    } finally {
      delete (Element.prototype as Partial<Element>).animate;
    }
  });

  it("leaves when the room goes", async () => {
    await show("room", "office");
    await act(async () => {
      live.publish({
        type: "places",
        places: { ...places, rooms: places.rooms.slice(1) },
      });
    });
    expect(back).toHaveBeenCalledTimes(1);
  });
});

describe("contact sensors", () => {
  const readingsLine = () =>
    container.querySelector(
      "header [data-slot=readings]",
    ) as HTMLElement | null;

  it.each(["unread", "offline", "quiet"] as const)(
    "keeps a room's contact icon unknown while its sensors are %s",
    async (state) => {
      const unknown: DeviceInfo = {
        ...contactSensor(
          "front",
          "Front door",
          "office",
          state === "unread" ? null : false,
        ),
        availability: state === "offline" ? "offline" : "unknown",
        lastSeenAt:
          state === "quiet"
            ? new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString()
            : null,
      };
      devices = [unknown];
      await show("room", "office");

      expect(readingsLine()?.textContent).toBe("Contact Sensors No readings");
      expect(
        readingsLine()?.querySelector("svg")?.getAttribute("stroke-dasharray"),
      ).toBe("3 3");

      for (const open of [false, true]) {
        devices = [unknown, contactSensor("back", "Back door", "office", open)];
        await act(async () => {
          live.refresh();
        });
        expect(readingsLine()?.textContent).toBe(
          `Contact Sensors ${open ? "1 open" : "1 closed"}`,
        );
        const icon = readingsLine()?.querySelector("svg");
        expect(icon?.hasAttribute("stroke-dasharray")).toBe(false);
        expect(
          icon?.classList.contains(
            open ? "lucide-contact-open" : "lucide-contact-closed",
          ),
        ).toBe(true);
      }
    },
  );

  it("say in their room's line whether any is open, and have a section under Security", async () => {
    devices = [
      lamp,
      contactSensor("front", "Front door", "office", true),
      contactSensor("letterbox", "Letterbox", "office", false),
    ];
    await show("room", "office");

    expect(readingsLine()?.textContent).toBe("Contact Sensors 1 open");
    expect(headings()).toEqual(["Lights", "Security"]);
    expect(tile("Front door")?.textContent).toBe("Front doorOpen");
    // Its tile switches nothing: one button, which opens its detail.
    await click(tile("Letterbox"));
    expect(openDevice).toHaveBeenCalledWith(
      expect.objectContaining({ key: "letterbox/contact" }),
    );
    expect(posted("/api/devices/command")).toEqual([]);
  });

  it("have Security's page, their tiles by room, which the sidebar lists", async () => {
    devices = [
      lamp,
      contactSensor("front", "Front door", "hall", true),
      contactSensor("letterbox", "Letterbox", "hall", false),
      contactSensor("window", "Window", "office", null),
    ];
    await show("category", "security");

    expect(container.querySelector("h1")?.textContent).toBe("Security");
    expect(tile("Front door")?.textContent).toBe("Front doorOpen");
    // The page's sections, then the sidebar's own headings.
    expect(headings()).toEqual(["Office", "Hall", "Categories", "Rooms"]);
    expect(
      [...container.querySelectorAll("nav button")].map(
        (each) => each.textContent,
      ),
    ).toEqual(["Lights1 on", "Security1 open", "Office", "Hall", "Attic"]);
  });
});

describe("the climate", () => {
  const readingsLine = () =>
    container.querySelector(
      "header [data-slot=readings]",
    ) as HTMLElement | null;

  it("of a room is under its name: each measure, ranged across its sensors, offline ones left out", async () => {
    devices = [
      lamp,
      sensor("desk", "office", 19.5, 58),
      sensor("window", "office", 20.24, 55.4),
      sensor("door", "office", 12, 90, "offline"),
    ];
    await show("room", "office");

    // Each measure is named for screen readers, as its icon shows it.
    expect(readingsLine()?.textContent).toBe(
      "Temperature 19.5–20.2°Humidity 55–58%",
    );
    expect(headings()).toEqual(["Lights", "Environment"]);
  });

  it("is not on the page of a room without sensors", async () => {
    await show("room", "office");
    expect(readingsLine()).toBeNull();
  });

  it("of the home heads Environment's page, which the sidebar lists before Buttons", async () => {
    devices = [
      lamp,
      plug,
      sensor("desk", "office", 21.5, 48),
      sensor("hall", "hall", 19.5, 58),
    ];
    await show("category", "environment");

    expect(container.querySelector("h1")?.textContent).toBe("Environment");
    // Its cards say what the sensors read; nothing is under its name.
    expect(container.querySelector("header p")).toBeNull();
    expect(
      [...container.querySelectorAll("nav button")].map(
        (each) => each.textContent,
      ),
    ).toEqual([
      "Lights1 on",
      "Environment19.5–21.5°",
      "Switches1 on",
      "Office",
      "Hall",
      "Attic",
    ]);
    expect(
      container
        .querySelector("nav [aria-current=page]")
        ?.getAttribute("aria-label"),
    ).toBe("Environment, 19.5 to 21.5°");
  });
});

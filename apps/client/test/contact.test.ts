import { deviceCategories, type DeviceInfo } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import {
  contactPageName,
  contactsOf,
  contactsStatus,
  contactsSummary,
  contactNowText,
  contactText,
  placeContacts,
} from "../src/contact";
import { sectionsOfRoom, tilesIn, tilesOf } from "../src/device-tiles";
import { contactSensor, places, sensor } from "./place-pages-fixtures";

// What contact sensors say: words on a tile, in a room's line and in the
// home's status, by one rule for open, closed and not known.

const minute = 60_000;
// 15:00 where the tests run, so the day and yesterday are local.
const now = new Date(2026, 9, 31, 15, 0).getTime();
const ago = (ms: number) => new Date(now - ms).toISOString();

const tiles = (devices: DeviceInfo[]) =>
  tilesOf(devices, places, new Map(), now);

describe("a contact sensor's words", () => {
  it("say Closed, or for how long it has been open", () => {
    expect(contactText(false, ago(5 * minute), now)).toBe("Closed");
    expect(contactText(true, ago(30_000), now)).toBe("Open");
    expect(contactText(true, ago(12 * minute + 30_000), now)).toBe(
      "Open for 12 min",
    );
    expect(contactText(true, ago(59 * minute), now)).toBe("Open for 59 min");
  });

  it("say since when from an hour, then yesterday, then the date", () => {
    expect(
      contactText(true, new Date(2026, 9, 31, 13, 5).toISOString(), now),
    ).toBe("Open since 13:05");
    expect(
      contactText(true, new Date(2026, 9, 30, 23, 50).toISOString(), now),
    ).toBe("Open since yesterday");
    expect(
      contactText(true, new Date(2026, 9, 28, 9, 0).toISOString(), now),
    ).toBe("Open since 28 Oct");
  });

  it("say only Open when it is not known since when", () => {
    expect(contactText(true, null, now)).toBe("Open");
  });

  it("say on its detail since when it has been closed, which a tile leaves out", () => {
    expect(contactNowText(true, ago(12 * minute), now)).toBe("Open for 12 min");
    expect(contactNowText(false, ago(30_000), now)).toBe("Closed");
    expect(contactNowText(false, ago(12 * minute), now)).toBe(
      "Closed for 12 min",
    );
    expect(
      contactNowText(false, new Date(2026, 9, 31, 13, 56).toISOString(), now),
    ).toBe("Closed since 13:56");
    expect(
      contactNowText(false, new Date(2026, 9, 30, 23, 50).toISOString(), now),
    ).toBe("Closed since yesterday");
    expect(
      contactNowText(false, new Date(2026, 9, 28, 9, 0).toISOString(), now),
    ).toBe("Closed since 28 Oct");
    expect(contactNowText(false, null, now)).toBe("Closed");
  });
});

describe("a contact sensor's tile", () => {
  it("is White while it is open, saying for how long, and says Closed otherwise", () => {
    const shown = tiles([
      contactSensor("front", "Front door", "hall", true, ago(12 * minute)),
      contactSensor("letterbox", "Letterbox", "hall", false, ago(minute)),
    ]);

    expect(
      shown.map((tile) => [tile.kind, tile.status, tile.look, tile.on]),
    ).toEqual([
      ["contact", "Open for 12 min", "on", true],
      ["contact", "Closed", "off", false],
    ]);
    expect(shown[0]?.contact).toEqual({
      open: true,
      changedAt: ago(12 * minute),
    });
  });

  it("is not known while it waits for a reading, is offline or has gone quiet", () => {
    const shown = tiles([
      contactSensor("new", "New", "hall", null),
      {
        ...contactSensor("cellar", "Cellar door", "hall", false),
        availability: "offline",
      },
      {
        ...contactSensor("attic", "Attic window", "attic", false),
        availability: "unknown",
        lastSeenAt: ago(4 * 24 * 60 * minute),
      },
    ]);

    expect(shown.map((tile) => [tile.status, tile.disabled])).toEqual([
      ["Waiting for a reading", false],
      ["Offline", true],
      ["Not heard from", false],
    ]);
    expect(shown.map((tile) => tile.contact)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("is under Security, beside its readings' under Environment, and one tile under Security on its room's page", () => {
    const measuring = contactSensor("window", "Window", "office", false);
    const devices = [
      {
        ...measuring,
        capabilities: [
          ...measuring.capabilities,
          ...sensor("window", "office", 21, 48).capabilities,
        ],
      },
    ];
    const shown = tiles(devices);

    expect(
      deviceCategories.map((category) => [
        category.title,
        tilesIn(category, shown).map((tile) => tile.status),
      ]),
    ).toEqual([
      ["Lights", []],
      ["Switches", []],
      ["Environment", ["21° · 48%"]],
      ["Presence", []],
      ["Security", ["Closed"]],
      ["Media", []],
      ["Buttons", []],
    ]);
    expect(
      sectionsOfRoom(shown, devices).map((section) => [
        section.title,
        section.tiles.map((tile) => tile.status),
      ]),
    ).toEqual([["Security", ["Closed"]]]);
  });
});

describe("some contact sensors", () => {
  const door = (id: string, open: boolean | null) =>
    contactSensor(id, `${id} door`, "hall", open);
  const offline = (id: string): DeviceInfo => ({
    ...door(id, false),
    availability: "offline",
  });
  // What the home's status says of them, then a room's line.
  const said = (devices: DeviceInfo[]) => [
    contactsStatus(contactsOf(tiles(devices))!),
    placeContacts(tiles(devices))?.text,
  ];

  it("are nothing where there is none", () => {
    expect(contactsOf(tiles([sensor("desk", "office", 21, 48)]))).toBeNull();
    expect(placeContacts(tiles([]))).toBeNull();
  });

  it("count those open, even while others are not known", () => {
    expect(said([door("front", true), door("back", false)])).toEqual([
      "1 open",
      "1 open",
    ]);
    expect(
      said([door("front", true), door("back", true), offline("side")]),
    ).toEqual(["2 open", "2 open"]);
    expect(placeContacts(tiles([door("front", true)]))?.open).toBe(true);
    expect(placeContacts(tiles([door("front", false)]))?.open).toBe(false);
  });

  it("are all closed only when each has said so", () => {
    expect(said([door("front", false), door("back", false)])).toEqual([
      "All closed",
      "All closed",
    ]);
    // One sensor alone in a room is closed, not "all" of them.
    expect(said([door("front", false)])).toEqual(["All closed", "Closed"]);
    expect(
      said([door("front", false), door("back", false), offline("side")]),
    ).toEqual(["2 closed", "2 closed"]);
  });

  it("say on their card how many are not known, while any other is known", () => {
    const summary = (devices: DeviceInfo[]) =>
      contactsSummary(contactsOf(tiles(devices))!);

    expect(summary([door("front", true), door("back", false)])).toEqual({
      open: true,
      status: "1 open",
      note: null,
    });
    expect(summary([door("front", true), offline("side")])).toEqual({
      open: true,
      status: "1 open",
      note: "1 not known",
    });
    expect(summary([door("front", false), door("back", false)])).toEqual({
      open: false,
      status: "All closed",
      note: null,
    });
    expect(
      summary([door("front", false), door("new", null), offline("side")]),
    ).toEqual({ open: false, status: "1 closed", note: "2 not known" });
    // With none known, "No readings" says it all.
    expect(summary([door("new", null), offline("side")])).toEqual({
      open: false,
      status: "No readings",
      note: null,
    });
  });

  it("have no readings while none is known", () => {
    expect(said([door("new", null), offline("side")])).toEqual([
      "No readings",
      "No readings",
    ]);
  });
});

describe("contact sensors shown as doors and windows", () => {
  const sensor = (id: string, open: boolean | null) =>
    contactSensor(id, id, "hall", open);
  const shown = (
    id: string,
    as: "door" | "window",
    open: boolean | null,
  ): DeviceInfo => ({ ...sensor(id, open), type: as, shownAs: as });
  const line = (devices: DeviceInfo[]) => {
    const { text, shownAs, label } = placeContacts(tiles(devices))!;
    return [text, shownAs, label];
  };

  it("carry what the household shows them as on their tile, and nothing while it shows none", () => {
    const [front, letterbox] = tiles([
      shown("front", "door", true),
      sensor("letterbox", false),
    ]);
    expect(front).toMatchObject({ kind: "contact", shownAs: "door" });
    expect(letterbox).not.toHaveProperty("shownAs");
  });

  it("name their detail's page for what they are shown as", () => {
    expect(contactPageName("door")).toBe("Door");
    expect(contactPageName("window")).toBe("Window");
    expect(contactPageName()).toBe("Contact");
  });

  it("are counted apart, each type by itself", () => {
    const home = tiles([
      shown("front", "door", true),
      shown("back", "door", false),
      shown("kitchen", "window", false),
      sensor("letterbox", null),
    ]);
    expect(contactsOf(home, "door")).toEqual({
      open: 1,
      closed: 1,
      unknown: 0,
    });
    expect(contactsOf(home, "window")).toEqual({
      open: 0,
      closed: 1,
      unknown: 0,
    });
    expect(contactsOf(home, "contact")).toEqual({
      open: 0,
      closed: 0,
      unknown: 1,
    });
    expect(contactsOf(home)).toEqual({ open: 1, closed: 2, unknown: 1 });
    expect(contactsOf(tiles([sensor("letterbox", false)]), "door")).toBeNull();
  });

  it("name what is open in a room's line where that is all doors or all windows", () => {
    expect(line([shown("front", "door", true)])).toEqual([
      "Door open",
      "door",
      null,
    ]);
    expect(
      line([shown("front", "door", true), shown("back", "door", true)]),
    ).toEqual(["2 doors open", "door", null]);
    expect(line([shown("kitchen", "window", true)])).toEqual([
      "Window open",
      "window",
      null,
    ]);
    // What is closed beside them does not change what is open.
    expect(
      line([
        shown("kitchen", "window", true),
        shown("bath", "window", true),
        shown("front", "door", false),
        sensor("letterbox", false),
      ]),
    ).toEqual(["2 windows open", "window", null]);
  });

  it("count contact sensors and a mix, by the sensor's own glyph", () => {
    expect(line([sensor("letterbox", true)])).toEqual([
      "1 open",
      undefined,
      "Contact sensors",
    ]);
    expect(
      line([shown("front", "door", true), shown("kitchen", "window", true)]),
    ).toEqual(["2 open", undefined, "Contact sensors"]);
    expect(
      line([shown("front", "door", true), sensor("letterbox", true)]),
    ).toEqual(["2 open", undefined, "Contact sensors"]);
  });

  it("say closed as before, by the door's or the window's glyph where every sensor there is one", () => {
    expect(
      line([shown("front", "door", false), shown("back", "door", false)]),
    ).toEqual(["All closed", "door", "Doors"]);
    expect(line([shown("kitchen", "window", false)])).toEqual([
      "Closed",
      "window",
      "Windows",
    ]);
    expect(
      line([shown("front", "door", false), shown("kitchen", "window", false)]),
    ).toEqual(["All closed", undefined, "Contact sensors"]);
    expect(line([shown("front", "door", null)])).toEqual([
      "No readings",
      "door",
      "Doors",
    ]);
  });
});

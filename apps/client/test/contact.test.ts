import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import {
  contactsOf,
  contactsStatus,
  contactText,
  placeContacts,
} from "../src/contact";
import { sectionsByCategory, tilesOf } from "../src/device-tiles";
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

  it("is under Security, after Presence, and beside its readings' under Environment", () => {
    const measuring = contactSensor("window", "Window", "office", false);
    const shown = tiles([
      {
        ...measuring,
        capabilities: [
          ...measuring.capabilities,
          ...sensor("window", "office", 21, 48).capabilities,
        ],
      },
    ]);

    expect(
      sectionsByCategory(shown).map((section) => [
        section.title,
        section.tiles.map((tile) => tile.status),
      ]),
    ).toEqual([
      ["Environment", ["21° · 48%"]],
      ["Security", ["Closed"]],
    ]);
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

  it("have no readings while none is known", () => {
    expect(said([door("new", null), offline("side")])).toEqual([
      "No readings",
      "No readings",
    ]);
  });
});

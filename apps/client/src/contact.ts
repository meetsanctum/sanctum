import type { ContactShownAs, Tile } from "@meetsanctum/ui-sdk";

import { midnight, timeText } from "./device-history-data";

// What contact sensors say, in words: on a sensor's tile, in a room's line
// under its name, in the home's status and on Security's summary cards,
// one for the doors, one for the windows and one for the sensors shown as
// neither. A sensor is
// open, closed or not known: one that is offline, has gone quiet on its
// battery or has said nothing yet is not known, and is never counted as
// closed. So "All closed" needs a closed reading from every sensor, and
// open ones are counted even while others are not known.

const minute = 60_000;
const hour = 60 * minute;

const date = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
});

/**
 * What a contact sensor says while it answers: "Closed", or for how long
 * it has been open, short enough for a tile ("Open since yesterday"). One
 * that has not said when it opened says only "Open".
 */
export function contactText(
  open: boolean,
  changedAt: string | null,
  now: number,
) {
  if (!open) return "Closed";
  const since = changedAt === null ? NaN : Date.parse(changedAt);
  if (Number.isNaN(since) || now - since < minute) return "Open";
  if (now - since < hour) {
    return `Open for ${Math.floor((now - since) / minute)} min`;
  }
  if (since >= midnight(now)) return `Open since ${timeText(since)}`;
  if (since >= midnight(now, 1)) return "Open since yesterday";
  return `Open since ${date.format(since)}`;
}

/**
 * What a contact sensor's detail says now: as its tile while open, and
 * while closed since when, which a tile leaves out: "Closed since 13:56".
 */
export function contactNowText(
  open: boolean,
  changedAt: string | null,
  now: number,
) {
  if (open) return contactText(true, changedAt, now);
  const since = changedAt === null ? NaN : Date.parse(changedAt);
  if (Number.isNaN(since) || now - since < minute) return "Closed";
  if (now - since < hour) {
    return `Closed for ${Math.floor((now - since) / minute)} min`;
  }
  if (since >= midnight(now)) return `Closed since ${timeText(since)}`;
  if (since >= midnight(now, 1)) return "Closed since yesterday";
  return `Closed since ${date.format(since)}`;
}

/** How some contact sensors are: how many are open, closed and not known. */
export type Contacts = { open: number; closed: number; unknown: number };

/** What a contact sensor counts among: the doors, the windows, or the sensors shown as neither. */
export type ContactType = ContactShownAs | "contact";

/**
 * Each type in the order its card and its words come: what its card and a
 * sensor's detail page are called, and what one and several are called in
 * a room's line.
 */
export const contactTypes: readonly {
  type: ContactType;
  title: string;
  page: string;
  one: string;
  several: string;
}[] = [
  { type: "door", title: "Doors", page: "Door", one: "Door", several: "doors" },
  {
    type: "window",
    title: "Windows",
    page: "Window",
    one: "Window",
    several: "windows",
  },
  {
    type: "contact",
    title: "Contact sensors",
    page: "Contact",
    one: "Contact sensor",
    several: "contact sensors",
  },
];

/** What a contact sensor's detail page is called, by what it is shown as. */
export const contactPageName = (shownAs?: ContactShownAs) =>
  contactTypes.find((each) => each.type === (shownAs ?? "contact"))!.page;

const typeOf = (tile: Tile): ContactType => tile.shownAs ?? "contact";

/**
 * The contact sensors among some tiles, all of them or those of one type,
 * or null when there is none.
 */
export function contactsOf(
  tiles: readonly Tile[],
  type?: ContactType,
): Contacts | null {
  const sensors = tiles.filter(
    (tile) =>
      tile.kind === "contact" && (type === undefined || typeOf(tile) === type),
  );
  if (sensors.length === 0) return null;
  const known = sensors.flatMap((tile) =>
    tile.contact && !tile.disabled ? [tile.contact] : [],
  );
  const open = known.filter((each) => each.open).length;
  return {
    open,
    closed: known.length - open,
    unknown: sensors.length - known.length,
  };
}

// What they say while none is open: nothing read, all closed, or how many
// are, while others are not known.
function closedText(contacts: Contacts, all: string) {
  if (contacts.closed === 0) return "No readings";
  return contacts.unknown === 0 ? all : `${contacts.closed} closed`;
}

/**
 * Contact sensors as the home's status counts them: "1 open", "All
 * closed", "2 closed" while others are not known, or "No readings". It
 * names none: a status tile has no room for a name.
 */
export function contactsStatus(contacts: Contacts) {
  return contacts.open > 0
    ? `${contacts.open} open`
    : closedText(contacts, "All closed");
}

// The one type some contact sensors' tiles are all of, or none for a mix.
function oneType(tiles: readonly Tile[]) {
  const types = new Set(tiles.map(typeOf));
  return types.size === 1
    ? contactTypes.find((each) => each.type === typeOf(tiles[0]!))!
    : null;
}

/**
 * A place's contact sensors as its line says them, and whether any is
 * open. What is open is named where it is all doors or all windows: "Door
 * open", "2 windows open"; contact sensors and a mix are counted, "2
 * open". Its glyph is the door's or the window's where what is open, or
 * while nothing is, every sensor there, is one; and what it counts is said
 * before it for a screen reader unless its words name it.
 */
export function placeContacts(tiles: readonly Tile[]) {
  const sensors = tiles.filter((tile) => tile.kind === "contact");
  const contacts = contactsOf(tiles);
  if (!contacts) return null;
  const open = contacts.open > 0;
  const opened = oneType(
    sensors.filter((tile) => !tile.disabled && tile.contact?.open),
  );
  const all = oneType(sensors);
  const named = open && opened !== null && opened.type !== "contact";
  const type = (open ? opened : all)?.type ?? "contact";
  return {
    open,
    isUnknown: !open && contacts.closed === 0,
    text: named
      ? contacts.open === 1
        ? `${opened.one} open`
        : `${contacts.open} ${opened.several} open`
      : open
        ? `${contacts.open} open`
        : closedText(contacts, contacts.closed === 1 ? "Closed" : "All closed"),
    ...(type !== "contact" && { shownAs: type }),
    label: named ? null : (all ?? contactTypes.at(-1)!).title,
  };
}

/**
 * Contact sensors as a summary card says them: how many are open, "All
 * closed" once each has said so, how many are closed while others are not
 * known, or "No readings"; under it, how many are not known while any
 * other is known, since a count must not hide a sensor nobody can vouch
 * for; and whether any is open.
 */
export function contactsSummary(contacts: Contacts) {
  const known = contacts.open + contacts.closed;
  return {
    open: contacts.open > 0,
    status: contactsStatus(contacts),
    note:
      contacts.unknown > 0 && known > 0
        ? `${contacts.unknown} not known`
        : null,
  };
}

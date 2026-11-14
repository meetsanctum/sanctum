import type { Tile } from "@meetsanctum/ui-sdk";

import { midnight, timeText } from "./device-history-data";

// What contact sensors say, in words: on a sensor's tile, in a room's line
// under its name, on Security's page and in the home's status. A sensor is
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

/** How some contact sensors are: those open, by name, and how many are closed and not known. */
export type Contacts = { open: string[]; closed: number; unknown: number };

/** The contact sensors among some tiles, or null when there is none. */
export function contactsOf(tiles: readonly Tile[]): Contacts | null {
  const sensors = tiles.filter((tile) => tile.kind === "contact");
  if (sensors.length === 0) return null;
  const known = sensors.flatMap((tile) =>
    tile.contact && !tile.disabled
      ? [{ ...tile.contact, name: tile.name }]
      : [],
  );
  const open = known
    .filter((each) => each.open)
    .map((each) => each.name)
    .sort((a, b) => a.localeCompare(b));
  return {
    open,
    closed: known.length - open.length,
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
  return contacts.open.length > 0
    ? `${contacts.open.length} open`
    : closedText(contacts, "All closed");
}

/** A place's contact sensors as its line says them, and whether any is open. */
export function placeContacts(tiles: readonly Tile[]) {
  const contacts = contactsOf(tiles);
  if (!contacts) return null;
  const open = contacts.open.length > 0;
  return {
    open,
    text: open
      ? `${contacts.open.length} open`
      : closedText(contacts, contacts.closed === 1 ? "Closed" : "All closed"),
  };
}

/**
 * Contact sensors as Security's page says them, with the names of one or
 * two that are open: "Front door is open", "Front door and Letterbox are
 * open", "3 open", "All closed", "2 closed, 1 not known" or "No readings".
 */
export function contactsSentence(contacts: Contacts) {
  const { open } = contacts;
  if (open.length === 1) return `${open[0]} is open`;
  if (open.length === 2) return `${open[0]} and ${open[1]} are open`;
  if (open.length > 2) return `${open.length} open`;
  return contacts.closed > 0 && contacts.unknown > 0
    ? `${contacts.closed} closed, ${contacts.unknown} not known`
    : closedText(contacts, "All closed");
}

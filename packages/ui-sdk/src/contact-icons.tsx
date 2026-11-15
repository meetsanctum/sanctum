import {
  createLucideIcon,
  DoorClosed,
  DoorOpen,
  type LucideIcon,
} from "lucide-react";

// A contact sensor's two glyphs, which Lucide has none for, drawn on its
// grid in its manner: the sensor with its magnet beside it while closed,
// and apart from it while open.

export const ContactClosed = createLucideIcon("contact-closed", [
  ["rect", { x: "4", y: "3", width: "9", height: "18", rx: "2", key: "body" }],
  [
    "rect",
    { x: "15.5", y: "7", width: "4", height: "10", rx: "1.5", key: "magnet" },
  ],
]);

export const ContactOpen = createLucideIcon("contact-open", [
  ["rect", { x: "2", y: "3", width: "9", height: "18", rx: "2", key: "body" }],
  [
    "rect",
    { x: "18", y: "7", width: "4", height: "10", rx: "1.5", key: "magnet" },
  ],
]);

// A window, which Lucide has none for either: its frame with four panes,
// on its sill, beside Lucide's door on its threshold; and open, one half
// swung out as Lucide's open door is.
export const WindowClosed = createLucideIcon("window-closed", [
  [
    "rect",
    { x: "4", y: "3", width: "16", height: "14", rx: "2", key: "frame" },
  ],
  ["path", { d: "M12 3v14", key: "mullion" }],
  ["path", { d: "M4 10h16", key: "transom" }],
  ["path", { d: "M2 21h20", key: "sill" }],
]);

export const WindowOpen = createLucideIcon("window-open", [
  ["path", { d: "M12 3h6a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-6z", key: "half" }],
  ["path", { d: "M12 10h8", key: "transom" }],
  ["path", { d: "M12 3L5 5.5v9l7 2.5", key: "leaf" }],
  ["path", { d: "M2 21h20", key: "sill" }],
]);

/** What the household shows a contact sensor as, where it chose: a door or a window. */
export type ContactShownAs = "door" | "window";

/**
 * A contact sensor's glyph, open or closed: the door's or the window's
 * where the household shows it as one, and the sensor's own otherwise.
 */
export function contactIcon(
  shownAs: ContactShownAs | null | undefined,
  open: boolean,
): LucideIcon {
  if (shownAs === "door") return open ? DoorOpen : DoorClosed;
  if (shownAs === "window") return open ? WindowOpen : WindowClosed;
  return open ? ContactOpen : ContactClosed;
}

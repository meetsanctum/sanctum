import { createLucideIcon } from "lucide-react";

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
// on its sill, beside Lucide's door on its threshold.
export const WindowClosed = createLucideIcon("window-closed", [
  [
    "rect",
    { x: "4", y: "3", width: "16", height: "14", rx: "2", key: "frame" },
  ],
  ["path", { d: "M12 3v14", key: "mullion" }],
  ["path", { d: "M4 10h16", key: "transom" }],
  ["path", { d: "M2 21h20", key: "sill" }],
]);

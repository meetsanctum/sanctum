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

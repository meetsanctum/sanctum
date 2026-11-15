import type { ContactFeatures, ContactState } from "@meetsanctum/app-sdk";

import { access, type ZigbeeExpose } from "./types.js";

// A contact sensor's contact, as Zigbee2MQTT publishes it: a binary by the
// exact property `contact`, whose true means the contact is made, so what
// it sits on is closed, and whose false means open. The core's kind says
// the opposite, whether it is open. A sensor's tamper is not the contact
// and stays out; its battery_low is its battery's (sensors.ts).

export type ContactMapping = {
  kind: "contact";
  // The expose's name, which the core knows the sensor's part by.
  id: "contact";
  property: string;
  /** What it publishes while open and while closed, where it says neither true nor false. */
  open: unknown;
  closed: unknown;
  features: ContactFeatures;
  /** The properties Zigbee2MQTT can read again with /get. */
  readable: string[];
};

/** A contact sensor's contact; null for any other expose. */
export function mapContact(expose: ZigbeeExpose): ContactMapping | null {
  if (
    expose.type !== "binary" ||
    expose.property !== "contact" ||
    (expose.access !== undefined && (expose.access & access.state) === 0)
  ) {
    return null;
  }
  return {
    kind: "contact",
    id: "contact",
    property: expose.property,
    // Zigbee2MQTT calls an open contact on: its value_on is false.
    open: expose.value_on ?? false,
    closed: expose.value_off ?? true,
    features: {},
    readable:
      expose.access !== undefined && (expose.access & access.get) !== 0
        ? [expose.property]
        : [],
  };
}

/**
 * Whether a contact sensor is open, from its message, or null when the
 * message does not say: a message with its battery alone, or with a value
 * that is neither, is never read as open.
 */
export function contactState(
  mapping: ContactMapping,
  payload: Record<string, unknown>,
): ContactState | null {
  const said = payload[mapping.property];
  // True is closed whatever else the device declares.
  if (typeof said === "boolean") {
    return { open: !said };
  }
  if (said === mapping.open) {
    return { open: true };
  }
  return said === mapping.closed ? { open: false } : null;
}

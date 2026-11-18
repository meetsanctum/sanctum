import { describe, expect, it } from "vitest";

import { contactState, mapContact } from "../src/contact.js";
import { deviceEntries } from "../src/devices.js";
import { capabilityMappings } from "../src/exposes.js";
import {
  aqaraContactSensor,
  contactExpose,
  sonoffContactSensor,
  zoneFlags,
} from "./contact-sensors.js";

// A contact sensor's contact (contact.ts): Zigbee2MQTT's true means
// closed, the core's kind says whether it is open.

const mapping = mapContact(contactExpose)!;

describe("a contact sensor's exposes", () => {
  it("make one contact, and nothing of its diagnostics and flags", () => {
    const contact = {
      kind: "contact",
      id: "contact",
      property: "contact",
      open: false,
      closed: true,
      features: {},
      readable: [],
    };
    for (const sensor of [
      aqaraContactSensor("0x01", "door"),
      sonoffContactSensor("0x02", "window"),
    ]) {
      expect(capabilityMappings(sensor.definition!.exposes!)).toEqual([
        contact,
      ]);
    }
    expect(capabilityMappings([contactExpose, ...zoneFlags])).toEqual([
      contact,
    ]);
  });

  it("take a contact by its exact property, published in its state", () => {
    expect(mapContact({ type: "binary", property: "contact" })).toMatchObject({
      open: false,
      closed: true,
      readable: [],
    });
    expect(
      mapContact({ type: "binary", property: "contact", access: 5 }),
    ).toMatchObject({ readable: ["contact"] });
    // One that is only set, a flag beside it and a contact that is no
    // binary are not one.
    expect(
      mapContact({ type: "binary", property: "contact", access: 2 }),
    ).toBeNull();
    expect(mapContact({ type: "binary", property: "tamper" })).toBeNull();
    expect(mapContact({ type: "binary", property: "contact_l1" })).toBeNull();
    expect(mapContact({ type: "enum", property: "contact" })).toBeNull();
  });

  it("register the sensor with its contact, asleep on its battery", () => {
    const [entry] = deviceEntries([aqaraContactSensor("0x01", "front_door")]);
    expect(entry).toMatchObject({
      key: "0x01",
      battery: true,
      registration: {
        name: "front_door",
        manufacturer: "Aqara",
        model: "MCCGQ11LM",
        // What it is, by its contact.
        type: "contact",
        capabilities: [{ id: "contact", kind: "contact" }],
        firmware: { sleeps: true },
        // It cannot be asked whether it is open.
        probe: false,
        identify: false,
      },
    });
  });
});

describe("what a contact sensor's message says", () => {
  it("is open when its contact is false, and closed when true", () => {
    expect(contactState(mapping, { contact: false })).toEqual({ open: true });
    expect(contactState(mapping, { contact: true, battery: 91 })).toEqual({
      open: false,
    });
  });

  it("is nothing when the message does not say its contact", () => {
    expect(contactState(mapping, { battery: 91, linkquality: 80 })).toBeNull();
    expect(contactState(mapping, { contact: null })).toBeNull();
    expect(contactState(mapping, { contact: "ajar" })).toBeNull();
    expect(contactState(mapping, { contact: 0 })).toBeNull();
    expect(contactState(mapping, {})).toBeNull();
  });

  it("goes by the values a device declares where it says neither true nor false", () => {
    const worded = mapContact({
      type: "binary",
      property: "contact",
      value_on: "OPEN",
      value_off: "CLOSED",
    })!;
    expect(contactState(worded, { contact: "OPEN" })).toEqual({ open: true });
    expect(contactState(worded, { contact: "CLOSED" })).toEqual({
      open: false,
    });
    expect(contactState(worded, { contact: "open" })).toBeNull();
    // True is closed whatever it declares.
    expect(contactState(worded, { contact: true })).toEqual({ open: false });
    const turned = mapContact({
      type: "binary",
      property: "contact",
      value_on: true,
      value_off: false,
    })!;
    expect(contactState(turned, { contact: true })).toEqual({ open: false });
    expect(contactState(turned, { contact: false })).toEqual({ open: true });
  });
});

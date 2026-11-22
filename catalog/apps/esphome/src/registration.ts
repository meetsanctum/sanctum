import {
  deviceTypeOf,
  type DeclaredType,
  type DeviceRegistration,
} from "@meetsanctum/app-sdk";

import type { Session } from "./connection.js";
import type { Mapping } from "./entities.js";

// What a device is in the core, from what its connection says: its name,
// maker and product, type, capabilities and firmware.

// Keep the core's length limit without cutting a Unicode character in half.
const label = (text: string | undefined) =>
  text
    ?.trim()
    .slice(0, 120)
    .replace(/[\uD800-\uDBFF]$/u, "") || null;

/**
 * Who made a device and what it is. A project named as ESPHome asks, maker
 * and product ("M5Stack.Atom Lite"), says both. Otherwise use the firmware's
 * manufacturer and the whole project name or board.
 */
export function makerOf(
  info: Pick<Session["info"], "projectName" | "manufacturer" | "model">,
) {
  if (info.projectName) {
    const [maker, product, extra] = info.projectName.split(".", 3);
    const manufacturer = label(maker);
    const model = label(product);
    if (extra === undefined && manufacturer && model) {
      return { manufacturer, model };
    }
  }
  return {
    manufacturer: label(info.manufacturer),
    model: label(info.projectName) ?? label(info.model),
  };
}

// The words that say a switch is a plug, where its device's switches have
// no class to say so: "Smart plug", "Outlet", "Socket".
const plugWords = /\b(plugs?|outlets?|sockets?)\b/i;

/**
 * What a device is. A plug switches like any switch, so its switches' class
 * says so first: a device whose every switch is an outlet is a plug, and one
 * with any other class is what its kinds make it. Where none of its switches
 * has a class, a whole word in its name or model says so. A light among its
 * capabilities makes it a light whatever its switches are.
 */
export function typeOf(
  mapping: Mapping,
  name: string,
  model: string | null,
): DeclaredType {
  const kinds = mapping.mapped.map((each) => each.capability.kind);
  // Only a switch entity has a class to read.
  const classes = mapping.mapped.flatMap((each) =>
    each.entity.type === "switch" ? [each.entity.deviceClass ?? ""] : [],
  );
  const plug =
    classes.length > 0 &&
    !kinds.includes("light") &&
    (classes.every((each) => each === "outlet") ||
      (classes.every((each) => each === "") &&
        plugWords.test(`${name} ${model ?? ""}`)));
  return plug ? "plug" : deviceTypeOf(kinds);
}

/** What a session says the device is, for the core's record. */
export function registrationOf(
  mac: string,
  session: Session,
  mapping: Mapping,
): DeviceRegistration {
  const { info } = session;
  const name = label(info.friendlyName) ?? label(info.name) ?? mac;
  const maker = makerOf(info);
  return {
    key: mac,
    name,
    ...maker,
    type: typeOf(mapping, name, maker.model),
    capabilities: mapping.mapped.map((each) => each.capability),
    firmware: {
      version: label(info.esphomeVersion),
      updatable: false,
      sleeps: info.hasDeepSleep === true,
    },
    // A light flashes to show itself, unless the device sleeps.
    identify:
      info.hasDeepSleep !== true &&
      mapping.mapped.some((each) => each.entity.type === "light"),
  };
}

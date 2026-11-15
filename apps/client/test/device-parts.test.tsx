import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DeviceIcon } from "../src/device-parts";
import { light } from "./settings-devices-fixtures";

// A device's icon in Settings: what the core says the device is.

const iconOf = (device?: DeviceInfo) =>
  /lucide-[a-z-]+/.exec(
    renderToStaticMarkup(<DeviceIcon device={device} />),
  )?.[0];

describe("a device's icon", () => {
  it("is its type's", () => {
    const icons = (
      [
        "light",
        "plug",
        "switch",
        "button",
        "motion",
        "contact",
        "door",
        "window",
        "sensor",
        "unknown",
      ] as const
    ).map((type) => iconOf(light("device", "Device", { type })));
    expect(icons).toEqual([
      "lucide-lightbulb",
      "lucide-power",
      "lucide-power",
      "lucide-circle-dot",
      "lucide-footprints",
      "lucide-contact-closed",
      "lucide-door-closed",
      "lucide-window-closed",
      "lucide-thermometer",
      "lucide-radio",
    ]);
  });

  it.each([
    ["contact", "lucide-contact-closed"],
    ["plug", "lucide-power"],
    ["door", "lucide-radio"],
    ["window", "lucide-radio"],
  ])("shows a driver's type %s only when a driver may say it", (type, icon) => {
    expect(renderToStaticMarkup(<DeviceIcon type={type} />)).toContain(icon);
  });

  it.each(["curtain", "constructor", "toString", "__proto__"])(
    "is the general one for the unfamiliar type %s",
    (type) => {
      expect(iconOf(light("device", "Device", { type: type as never }))).toBe(
        "lucide-radio",
      );
    },
  );

  it("is the general one for no device", () => {
    expect(iconOf()).toBe("lucide-radio");
  });
});

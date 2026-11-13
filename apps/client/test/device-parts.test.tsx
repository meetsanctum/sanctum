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
      "lucide-thermometer",
      "lucide-radio",
    ]);
  });

  it("is the general one for a type this client has none for, and for no device", () => {
    expect(
      iconOf(light("device", "Device", { type: "curtain" as never })),
    ).toBe("lucide-radio");
    expect(iconOf()).toBe("lucide-radio");
  });
});

import type { TemperatureUnit } from "@meetsanctum/app-sdk";
import type { LiveFeed } from "@meetsanctum/ui-sdk";
import { createContext, useContext, useMemo, type ReactNode } from "react";

import { useDevices, type Devices } from "./use-devices";

// The home's devices, held beside the signed-in screen rather than in it: a
// device's change draws only what reads them (useHomeDevices), such as the
// page, the sidebar's places and a device's detail, not the frame, the top
// bar and the menus around them. What the screen itself needs of them
// changes far less often (useDevicesSummary).

const DevicesContext = createContext<Devices | null>(null);
const SummaryContext = createContext<DevicesSummary | null>(null);

/** What the screen around the page needs of the devices. */
export type DevicesSummary = {
  /** Whether the core has answered with the home's devices yet. */
  loaded: boolean;
  /** Whether the home has no devices at all. */
  none: boolean;
  /** How the household reads things: units and time zone. */
  temperatureUnit: TemperatureUnit | undefined;
  timeZone: string | undefined;
  fail: Devices["fail"];
};

export function HomeDevicesProvider(props: {
  live: LiveFeed;
  children: ReactNode;
}) {
  const devices = useDevices(props.live);
  const { loaded, fail } = devices;
  const none = devices.devices.length === 0;
  const temperatureUnit = devices.places?.home.temperatureUnit;
  const timeZone = devices.places?.home.timeZone;
  const summary = useMemo(
    () => ({ loaded, none, temperatureUnit, timeZone, fail }),
    [loaded, none, temperatureUnit, timeZone, fail],
  );
  return (
    <SummaryContext.Provider value={summary}>
      <DevicesContext.Provider value={devices}>
        {props.children}
      </DevicesContext.Provider>
    </SummaryContext.Provider>
  );
}

/** The home's devices; whatever reads them draws again with each change. */
export function useHomeDevices() {
  const devices = useContext(DevicesContext);
  if (!devices) throw new Error("useHomeDevices outside HomeDevicesProvider");
  return devices;
}

/** What the screen needs of the devices, which changes far less often. */
export function useDevicesSummary() {
  const summary = useContext(SummaryContext);
  if (!summary) {
    throw new Error("useDevicesSummary outside HomeDevicesProvider");
  }
  return summary;
}

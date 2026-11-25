import {
  homeClock,
  hostTimeZone,
  type HomeClock,
  type HourCycle,
} from "@meetsanctum/app-sdk/clock";
import { createContext, useContext, useMemo, type ReactNode } from "react";

// The shell and apps' pages use the home's time zone from Settings → Household
// and the household's 24- or 12-hour preference, even on a device away from
// home. The time itself is the device's own.

const HomeClockContext = createContext<HomeClock | undefined>(undefined);

// Outside the shell, as in a test, the device's zone and 24 hours: the same
// clock while that zone stays.
let deviceClock: HomeClock | undefined;

/**
 * Where the shell puts the home clock, the home's time zone and its hours,
 * around itself and every app's UI.
 */
export function HomeTimeZoneProvider(props: {
  /** Undefined until the core has answered, or while the home has none: the device's. */
  timeZone: string | null | undefined;
  /** Undefined until the core has answered: 24 hours. */
  hourCycle?: HourCycle | null;
  children: ReactNode;
}) {
  const { timeZone, hourCycle } = props;
  const clock = useMemo(
    () => homeClock({ timeZone, hourCycle: hourCycle ?? undefined }),
    [timeZone, hourCycle],
  );
  return (
    <HomeClockContext.Provider value={clock}>
      {props.children}
    </HomeClockContext.Provider>
  );
}

/**
 * The home clock: the home's days and times, and its words for them, such
 * as 07:30 or 7:30 AM. It follows the household's changes live, and uses the
 * device's zone while the home's isn't known.
 */
export function useHomeClock(): HomeClock {
  const clock = useContext(HomeClockContext);
  if (clock) return clock;
  const zone = hostTimeZone();
  if (deviceClock?.timeZone !== zone)
    deviceClock = homeClock({ timeZone: zone });
  return deviceClock;
}

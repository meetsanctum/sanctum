import { createContext, useContext, type ReactNode } from "react";

// The home's time zone (Settings → Household), in which widgets' cards
// write times, so a card says the home's sunrise wherever the device is.
// Only the shell's own components read it.

const HomeTimeZoneContext = createContext<string | undefined>(undefined);

/** Where the shell puts the home's time zone, around itself and every app's UI. */
export function HomeTimeZoneProvider(props: {
  /** Undefined until the core has answered, or while the home has none: the device's. */
  timeZone: string | null | undefined;
  children: ReactNode;
}) {
  return (
    <HomeTimeZoneContext.Provider value={props.timeZone ?? undefined}>
      {props.children}
    </HomeTimeZoneContext.Provider>
  );
}

export function useHomeTimeZone(): string | undefined {
  return useContext(HomeTimeZoneContext);
}

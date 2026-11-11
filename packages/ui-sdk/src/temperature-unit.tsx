import type { TemperatureUnit } from "@meetsanctum/app-sdk";
import { createContext, useContext, type ReactNode } from "react";

// The unit the home shows temperatures in, which the household sets in
// Settings → Household. The shell reads it with the home's places and hands
// it to its own pages and apps' alike, so a page needs no permission to show
// a temperature as the household reads it.

const TemperatureUnitContext = createContext<TemperatureUnit | undefined>(
  undefined,
);

/** Where the shell puts the home's temperature unit, around itself and every app's UI. */
export function TemperatureUnitProvider(props: {
  /** Undefined until the core has answered. */
  unit: TemperatureUnit | undefined;
  children: ReactNode;
}) {
  return (
    <TemperatureUnitContext.Provider value={props.unit}>
      {props.children}
    </TemperatureUnitContext.Provider>
  );
}

/**
 * The unit the home shows temperatures in, followed live as the household
 * changes it; undefined until the core answers, so a page does not draw
 * Celsius first.
 */
export function useTemperatureUnit(): TemperatureUnit | undefined {
  return useContext(TemperatureUnitContext);
}

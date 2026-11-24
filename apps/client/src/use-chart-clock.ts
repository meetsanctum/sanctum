import { createContext, useContext, useEffect } from "react";

import { everyWhileShown, isShown } from "./while-shown";

export const ChartPageSelected = createContext(true);

/** Moves a chart's time while its tab and window are shown. */
export function useChartClock(setNow: (now: number) => void) {
  const selected = useContext(ChartPageSelected);
  useEffect(() => {
    if (!selected) return;
    const tick = () => setNow(Date.now());
    if (isShown()) tick();
    return everyWhileShown(60_000, tick);
  }, [selected, setNow]);
}

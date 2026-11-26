import { useSwipePageSelected } from "@meetsanctum/ui-sdk";
import { useEffect, useRef } from "react";

import { everyWhileShown, isShown } from "./while-shown";

// A chart's minute: the end of its day moves on each minute while the
// window is shown and its page is the one in view. A device's detail keeps
// every page mounted beside the one in view, so a page out of view waits,
// and catches up at once when it is shown again.

/** Moves a chart's time while its page and window are shown. */
export function useChartClock(setNow: (now: number) => void) {
  const selected = useSwipePageSelected();
  // The chart read the time as it mounted, so only a page shown again
  // catches up: a tick at mount would draw every chart twice as it opens.
  const mounted = useRef(false);
  useEffect(() => {
    const again = mounted.current;
    mounted.current = true;
    if (!selected) return;
    const tick = () => setNow(Date.now());
    if (again && isShown()) tick();
    return everyWhileShown(60_000, tick);
  }, [selected, setNow]);
}

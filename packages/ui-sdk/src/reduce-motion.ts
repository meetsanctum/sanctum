import { useSyncExternalStore } from "react";

// Reduce motion, a device's way of drawing the same screen without
// movement: what the page's <html> says, data-motion="reduced", which the
// shell sets (apps/client/src/effects.ts) and the frame runtime sets on an
// app's page. Most parts follow it in CSS, through the theme's
// `motion-reduce:` and `motion-safe:`; this is for the few that move from
// script, such as the colour wheel's circles flying in.

/** Whether this page draws with Reduce motion, read when it's needed. */
export const isMotionReduced = () =>
  document.documentElement.dataset.motion === "reduced";

function subscribe(changed: () => void) {
  const watch = new MutationObserver(changed);
  watch.observe(document.documentElement, {
    attributeFilter: ["data-motion"],
  });
  return () => watch.disconnect();
}

/** Whether this page draws with Reduce motion, kept current as it changes. */
export function useReducedMotion() {
  return useSyncExternalStore(subscribe, isMotionReduced, () => false);
}

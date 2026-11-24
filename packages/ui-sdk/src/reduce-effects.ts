import { useSyncExternalStore } from "react";

// Reduce effects, a device's way of drawing the same screen more plainly:
// what the page's <html> says, data-effects="reduced", which the shell sets
// (apps/client/src/effects.ts). Most parts follow it in CSS, through the
// theme's `frosted` and `reduce-effects:`; this is for the few that draw an
// effect from script, such as a row's edge fade.

const isReduced = () => document.documentElement.dataset.effects === "reduced";

function subscribe(changed: () => void) {
  const watch = new MutationObserver(changed);
  watch.observe(document.documentElement, {
    attributeFilter: ["data-effects"],
  });
  return () => watch.disconnect();
}

/** Whether this page draws with Reduce effects, kept current as it changes. */
export function useReducedEffects() {
  return useSyncExternalStore(subscribe, isReduced, () => false);
}

import { useEffect, useRef } from "react";

import { isMotionReduced } from "./reduce-motion";

// How long a tile shows that a command to it failed, in ms.
const showFailure = 900;

// A failed command: the tile quickly turns red and shakes, then fades back
// to how it was. Only opacity and transform move, and the shake is left out
// where motion is reduced.
export function showFailed(
  button: HTMLElement | null,
  wash: HTMLElement | null,
) {
  wash?.animate?.(
    [
      { opacity: 0 },
      { opacity: 0.65, offset: 0.15 },
      { opacity: 0.65, offset: 0.55 },
      { opacity: 0 },
    ],
    { duration: showFailure, easing: "ease-out" },
  );
  if (isMotionReduced()) return;
  const shake = button?.animate?.(
    [0, -6, 6, -4, 4, -2, 0].map((x) => ({ transform: `translateX(${x}px)` })),
    { duration: showFailure / 2, delay: 60, easing: "ease-in-out" },
  );
  if (!shake) return;
  const motion = new MutationObserver(() => {
    if (isMotionReduced()) shake.cancel();
  });
  motion.observe(document.documentElement, {
    attributeFilter: ["data-motion"],
  });
  const stopWatching = () => motion.disconnect();
  void shake.finished.then(stopWatching, stopWatching);
}

/**
 * A tile's or a button's failed taps, each shown once as it comes, after
 * `onFailed` where a failure undoes something first: the element and its
 * red wash, to give their refs. Only failures from while it is shown show,
 * so a page opened later starts calm.
 */
export function useShowFailed(failures = 0, onFailed?: () => void) {
  const surface = useRef<HTMLButtonElement | null>(null);
  const wash = useRef<HTMLSpanElement>(null);
  const shown = useRef(failures);
  useEffect(() => {
    if (failures <= shown.current) return;
    shown.current = failures;
    onFailed?.();
    showFailed(surface.current, wash.current);
    // Only a new failure shows, whatever else changed.
  }, [failures]);
  return { surface, wash };
}

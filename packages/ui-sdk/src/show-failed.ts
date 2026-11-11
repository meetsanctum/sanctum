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
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  button?.animate?.(
    [0, -6, 6, -4, 4, -2, 0].map((x) => ({ transform: `translateX(${x}px)` })),
    { duration: showFailure / 2, delay: 60, easing: "ease-in-out" },
  );
}

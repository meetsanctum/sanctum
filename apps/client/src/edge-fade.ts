import { useLayoutEffect, type RefObject } from "react";

// A row that scrolls sideways fades its tiles out over 24 px at an edge
// with more beyond it, so no tile ends in a hard cut. Each tile is masked
// on its own, its gradient placed by where the row's edges cross it: a mask
// on the row would make it the backdrop of its tiles' frosted glass, which
// would then blur nothing. A tile with frosted glass carries its blur on
// the element the mask is on. The masks follow the scroll a frame at a
// time and go once the row fits.

const fade = 24;

export function useEdgeFade(
  ref: RefObject<HTMLElement | null>,
  { focusWhenScrollable = false } = {},
) {
  useLayoutEffect(() => {
    const row = ref.current;
    if (!row) return;
    let frame = 0;
    const paint = () => {
      frame = 0;
      const box = row.getBoundingClientRect();
      const maxScroll = row.scrollWidth - row.clientWidth;
      const before = row.scrollLeft > 0;
      const after = row.scrollLeft < maxScroll - 1;
      if (focusWhenScrollable) {
        // Rows without controls need a tab stop for keyboard scrolling in Safari.
        const hasOverflow = maxScroll > 1;
        if (hasOverflow !== row.hasAttribute("tabindex")) {
          if (hasOverflow) row.tabIndex = 0;
          else row.removeAttribute("tabindex");
        }
      }
      for (const tile of row.children) {
        if (!(tile instanceof HTMLElement)) continue;
        let mask = "";
        if (before || after) {
          const at = tile.getBoundingClientRect();
          const start = box.left - at.left;
          const end = box.right - at.left;
          const stops = [
            before
              ? `transparent ${start}px, black ${start + fade}px`
              : "black 0px",
            after
              ? `black ${end - fade}px, transparent ${end}px`
              : "black 100%",
          ];
          mask = `linear-gradient(to right, ${stops.join(", ")})`;
        }
        tile.style.maskImage = mask;
        tile.style.webkitMaskImage = mask;
      }
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(paint);
    };
    paint();
    row.addEventListener("scroll", schedule, { passive: true });
    const resized =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(schedule);
    resized?.observe(row);
    for (const tile of row.children) resized?.observe(tile);
    return () => {
      row.removeEventListener("scroll", schedule);
      resized?.disconnect();
      window.cancelAnimationFrame(frame);
    };
  });
}

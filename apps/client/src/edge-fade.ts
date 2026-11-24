import { useReducedEffects } from "@meetsanctum/ui-sdk";
import { useLayoutEffect, useRef, type RefObject } from "react";

// A row that scrolls sideways fades its tiles out over 24 px at an edge
// with more beyond it, so no tile ends in a hard cut. Each tile is masked
// on its own, its gradient placed by where the row's edges cross it: a mask
// on the row would make it the backdrop of its tiles' frosted glass, which
// would then blur nothing. A tile with frosted glass carries its blur on
// the element the mask is on. The masks follow the scroll a frame at a
// time, and the row's and its tiles' sizes and which tiles it has, and go
// once the row fits. A row is followed from when it appears until it goes,
// not set up again on each render, which on a slow tablet measured every
// tile each time the home changed. Under Reduce effects a row has no fade,
// and its tiles end in a hard cut at its edge.

const fade = 24;

export function useEdgeFade(
  ref: RefObject<HTMLElement | null>,
  { focusWhenScrollable = false } = {},
) {
  const reduced = useReducedEffects();
  const followed = useRef<{
    row: HTMLElement;
    reduced: boolean;
    stop: () => void;
  } | null>(null);
  // Each render only checks the row is still the one followed, with the
  // same effects: a row can appear, go or be replaced as what it shows
  // changes. focusWhenScrollable is read when the hook starts following.
  useLayoutEffect(() => {
    const row = ref.current;
    if (followed.current?.row === row && followed.current.reduced === reduced) {
      return;
    }
    followed.current?.stop();
    followed.current =
      row && (!reduced || focusWhenScrollable)
        ? { row, reduced, stop: follow(row, focusWhenScrollable, !reduced) }
        : null;
  });
  useLayoutEffect(
    () => () => {
      followed.current?.stop();
      followed.current = null;
    },
    [],
  );
}

function follow(
  row: HTMLElement,
  focusWhenScrollable: boolean,
  fades: boolean,
) {
  let frame = 0;
  const paint = () => {
    frame = 0;
    const maxScroll = row.scrollWidth - row.clientWidth;
    if (focusWhenScrollable) {
      // Rows without controls need a tab stop for keyboard scrolling in Safari.
      const hasOverflow = maxScroll > 1;
      if (hasOverflow !== row.hasAttribute("tabindex")) {
        if (hasOverflow) row.tabIndex = 0;
        else row.removeAttribute("tabindex");
      }
    }
    if (!fades) return;
    const box = row.getBoundingClientRect();
    const before = row.scrollLeft > 0;
    const after = row.scrollLeft < maxScroll - 1;
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
          after ? `black ${end - fade}px, transparent ${end}px` : "black 100%",
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
  if (fades) row.addEventListener("scroll", schedule, { passive: true });
  const resized =
    typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  const observeAll = () => {
    resized?.disconnect();
    resized?.observe(row);
    for (const tile of row.children) resized?.observe(tile);
  };
  observeAll();
  // Tiles added, removed or moved: the new ones are watched too.
  const changed =
    typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => {
          observeAll();
          schedule();
        });
  changed?.observe(row, { childList: true });
  return () => {
    resized?.disconnect();
    changed?.disconnect();
    window.cancelAnimationFrame(frame);
    if (fades) {
      row.removeEventListener("scroll", schedule);
      for (const tile of row.children) {
        if (!(tile instanceof HTMLElement)) continue;
        tile.style.maskImage = "";
        tile.style.webkitMaskImage = "";
      }
    }
  };
}

import { cn } from "cn";
import { useId } from "react";

// The knot as a loading indicator: one line goes round the upright loop,
// turns right where it would close and goes round the lying loop, knotting
// it through, then back over its own turn. It pulls out the same way, and
// the next turn grows from the point where it vanished. The line is two
// stroked paths with the logo's 2-unit band on its 14-unit grid
// (src/knot.ts). A path shows a gap only where the other is passing over it: a
// copy of the other line, 1 unit wider on each side, is drawn in step with it
// in this path's mask, clipped to the two crossings where the other lies on
// top. At the top-left crossing that copy wipes the right turn too, which lies
// inside the clip. The motion is in src/styles.css; without it the knot is the
// logo. Drawn at 28 px, two pixels to a unit, it is as crisp as the logo when
// it holds.

// The upright loop and the right turn, which joins the left arm's end at
// (5, 7) to the top band's end at (7, 5). It starts half a unit past the logo's
// end at (5, 3), so that the mask draws that end, as it does all the others.
const upright = "M5 3.5V3A2 2 0 0 1 9 3V11A2 2 0 0 1 5 11V7A2 2 0 0 1 7 5";
// The lying loop, on from the turn. It runs on under the right arm to
// (10.5, 5), which is the upright path's start turned a quarter clockwise.
const lying = "M7 5H11A2 2 0 0 1 11 9H3A2 2 0 0 1 3 5H10.5";

export function KnotLoader(props: { className?: string }) {
  // Each knot on a screen needs its own mask and clip ids.
  const id = useId();
  return (
    <svg
      viewBox="0 0 14 14"
      aria-hidden="true"
      className={cn("knot-loader", props.className)}
    >
      <defs>
        {/* The upright loop passes under at top left and bottom right, the
            lying one at top right and bottom left. The top-left square runs
            half a unit on into the gap beside the top band, so that the
            turn's end is wiped whole at any scale. Both squares of each are
            one shape: inside a mask, WebKit draws nothing through a clip path
            of several. */}
        <clipPath id={`${id}upright-under`}>
          <polygon points="3,3 7.5,3 7.5,7 11,7 11,11 7,11 7,7 3,7" />
        </clipPath>
        <clipPath id={`${id}lying-under`}>
          <polygon points="7,3 11,3 11,7 7,7 7,11 3,11 3,7 7,7" />
        </clipPath>
        <mask
          id={`${id}upright`}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="14"
          height="14"
        >
          <rect width="14" height="14" fill="white" />
          <path
            className="knot-lying knot-cut"
            clipPath={`url(#${id}upright-under)`}
            d={lying}
          />
        </mask>
        <mask
          id={`${id}lying`}
          maskUnits="userSpaceOnUse"
          x="0"
          y="0"
          width="14"
          height="14"
        >
          <rect width="14" height="14" fill="white" />
          <path
            className="knot-upright knot-cut"
            clipPath={`url(#${id}lying-under)`}
            d={upright}
          />
        </mask>
      </defs>
      {/* Each turn is the last one turned a quarter. On this group and not the
          svg, which on a screen where it is not a whole number of device pixels
          across, such as at 2.625×, would shift half a pixel with each turn. */}
      <g>
        <path
          className="knot-upright"
          mask={`url(#${id}upright)`}
          d={upright}
        />
        <path className="knot-lying" mask={`url(#${id}lying)`} d={lying} />
      </g>
    </svg>
  );
}

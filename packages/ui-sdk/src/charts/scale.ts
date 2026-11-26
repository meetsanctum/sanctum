/** A chart's gridlines, by value, and the range from its foot to its top. */
export type ChartScale = { min: number; max: number; lines: number[] };

/**
 * Round values for a chart's gridlines: as many steps of one size as fit
 * two or three within what it shows, or, when none falls within, the one
 * nearest its middle; and the range the chart then spans, with room either
 * side so the line never runs along an edge.
 */
export function scaleOf(min: number, max: number): ChartScale {
  const span = max - min;
  // At large magnitudes, both the step and the padding must be representable.
  const needed = Math.max(
    0.5,
    Number.isFinite(span) ? span / 2.5 : max / 2.5 - min / 2.5,
    Math.max(Math.abs(min), Math.abs(max)) * Number.EPSILON,
  );
  const unit = 10 ** Math.floor(Math.log10(needed));
  const step = Math.min(
    Number.MAX_VALUE,
    ([1, 2, 5].find((multiple) => multiple * unit >= needed) ?? 10) * unit,
  );
  const first = Math.ceil(min / step);
  const last = Math.floor(max / step + 0.001);
  const lines: number[] = [];
  for (let tick = first; tick <= last && lines.length < 3; tick++) {
    const value = tick * step;
    if (!Number.isFinite(value)) break;
    lines.push(value || 0);
  }
  const finite = (value: number) =>
    Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, value));
  if (lines.length === 0) {
    const middle = min / 2 + max / 2;
    lines.push(finite(Math.round(middle / step) * step) || 0);
  }
  const pad = Math.max(
    step / 2,
    Number.isFinite(span) ? span * 0.1 : max * 0.1 - min * 0.1,
  );
  return {
    lines,
    min: finite(Math.min(min, lines[0]!) - pad),
    max: finite(Math.max(max, lines.at(-1)!) + pad),
  };
}

/** A value's position between the bounds, even when the span overflows. */
export function scaleFraction({ min, max }: ChartScale, value: number) {
  const span = max - min;
  return Number.isFinite(span)
    ? (value - min) / span
    : (value / 2 - min / 2) / (max / 2 - min / 2);
}

// Where a value in the unit shown sits, from the top, kept within the scale.
export function yOn(
  scale: ChartScale | null,
  height: number,
  shownValue: number,
) {
  return scale
    ? height -
        scaleFraction(
          scale,
          Math.min(scale.max, Math.max(scale.min, shownValue)),
        ) *
          height
    : height / 2;
}

// A gridline's centre, snapped to a pixel. The axis takes any gridline
// that would overlap it or fall below it.
export const gridYOn = (
  scale: ChartScale | null,
  height: number,
  value: number,
) => {
  const y = Math.round(yOn(scale, height, value)) + 0.5;
  const foot = height - 0.5;
  return y > foot - 1 ? foot : y;
};

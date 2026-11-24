/** A chart's gridlines, by value, and the range from its foot to its top. */
export type ChartScale = { min: number; max: number; lines: number[] };

/**
 * Round values for a chart's gridlines: as many steps of one size as fit
 * two or three within what it shows, or, when none falls within, the one
 * nearest its middle; and the range the chart then spans, with room either
 * side so the line never runs along an edge.
 */
export function scaleOf(min: number, max: number): ChartScale {
  const span = Math.max(max - min, 0.5);
  const step =
    [
      0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1_000, 2_000, 5_000, 10_000,
      20_000, 50_000,
    ].find((each) => span / each <= 2.5) ?? 100_000;
  const lines: number[] = [];
  for (
    let value = Math.ceil(min / step) * step;
    value <= max + step / 1000;
    value += step
  ) {
    lines.push(Math.round(value * 10) / 10);
  }
  if (lines.length === 0) {
    lines.push(Math.round((min + max) / 2 / step) * step);
  }
  const pad = Math.max(step / 2, (max - min) * 0.1);
  return {
    lines,
    min: Math.min(min, ...lines) - pad,
    max: Math.max(max, ...lines) + pad,
  };
}

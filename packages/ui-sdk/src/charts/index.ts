// @meetsanctum/ui-sdk/charts: Sanctum's charts, whole, for the shell and
// apps' pages alike. Each is drawn in SVG on whole pixels, takes plain
// times and values, and brings its own readout, which a tap pins, and list
// for screen readers. The kit serves them as a module of their own, so a
// page that charts nothing loads none of them.

export {
  DayBandChart,
  DayBandMarks,
  type BandLevel,
  type BandSpan,
  type DayBandChartProps,
  type DayBandMarksProps,
} from "./band";
export { DayTimeAxis, type DayTimeAxisProps } from "./axis";
export {
  DayStripChart,
  type DayStripChartProps,
  type StripMark,
  type StripSpan,
} from "./strip";
export {
  LineChart,
  type ChartFormat,
  type LineChartProps,
  type LinePoint,
} from "./line";
export type { ChartScale } from "./scale";
export {
  WeekColumnsChart,
  type WeekColumn,
  type WeekColumnsChartProps,
} from "./week-columns";
export {
  WeekRangeChart,
  type WeekRange,
  type WeekRangeChartProps,
  type WeekRangeFormat,
} from "./week-ranges";

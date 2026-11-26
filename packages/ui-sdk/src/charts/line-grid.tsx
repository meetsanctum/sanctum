import { ChartFoot } from "./frame";
import type { ChartFormat } from "./line";
import { gridYOn, type ChartScale } from "./scale";

type GridProps = { scale: ChartScale | null; height: number; page: boolean };

// The axis takes any gridline that would touch it, overlap it or fall below it.
function gridLinePosition(scale: ChartScale, height: number, value: number) {
  const y = gridYOn(scale, height, value);
  const foot = height - 0.5;
  const onFoot = y >= foot - 1;
  return { y: onFoot ? foot : y, onFoot };
}

// A line's gridlines at their round values, over the axis along its foot.
export function LineGridMarks({
  scale,
  height,
  page,
  plot,
}: GridProps & { plot: number }) {
  return (
    <>
      <ChartFoot plot={plot} height={height} page={page} />
      {scale?.lines.map((value) => {
        const { y, onFoot } = gridLinePosition(scale, height, value);
        if (onFoot) return null;
        return (
          <rect
            key={value}
            x={0}
            y={y - 0.5}
            width={plot}
            height={1}
            className={page ? "fill-foreground/12" : "fill-white/12"}
          />
        );
      })}
    </>
  );
}

export function LineGridLabels({
  scale,
  height,
  page,
  format,
}: GridProps & { format: ChartFormat }) {
  const label = page ? "text-muted-foreground" : "text-(--pewter)";
  return scale?.lines.map((value) => (
    <span
      key={value}
      aria-hidden="true"
      style={{ top: gridLinePosition(scale, height, value).y }}
      className={`absolute right-0 -translate-y-1/2 text-[13px] leading-[18px] tabular-nums ${label}`}
    >
      {format.grid(value)}
    </span>
  ));
}

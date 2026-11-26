import { ChartFoot } from "./frame";
import type { ChartFormat } from "./line";
import { gridYOn, type ChartScale } from "./scale";

type GridProps = { scale: ChartScale | null; height: number; page: boolean };

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
        const y = gridYOn(scale, height, value);
        if (y === height - 0.5) return null;
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
      style={{ top: gridYOn(scale, height, value) }}
      className={`absolute right-0 -translate-y-1/2 text-[13px] leading-[18px] tabular-nums ${label}`}
    >
      {format.grid(value)}
    </span>
  ));
}

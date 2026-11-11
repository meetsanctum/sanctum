import { useMemo } from "react";
import { encode } from "uqr";

// A QR code as one SVG path: Carbon modules on White in either mode, with a
// quiet zone, so a phone's camera reads it from across a kitchen.
export function QrCode(props: {
  text: string;
  label: string;
  className?: string;
}) {
  const { size, path } = useMemo(() => {
    const { data, size } = encode(props.text, { ecc: "M", border: 2 });
    let path = "";
    data.forEach((row, y) =>
      row.forEach((dark, x) => {
        if (dark) path += `M${x} ${y}h1v1h-1z`;
      }),
    );
    return { size, path };
  }, [props.text]);
  return (
    <svg
      role="img"
      aria-label={props.label}
      viewBox={`0 0 ${size} ${size}`}
      shapeRendering="crispEdges"
      className={props.className}
    >
      <rect width={size} height={size} fill="var(--white)" />
      <path d={path} fill="var(--carbon)" />
    </svg>
  );
}

import { formatPairingCode } from "@meetsanctum/auth-protocol";
import { cn } from "cn";

import { Skeleton } from "../components/ui/skeleton";

// The code a shared device shows, in the boxes the approving device types it
// into: eight, four and four with a dash between, one character to a box,
// so people copy it box by box. These boxes are filled but have no outline,
// so nobody takes them for a field to press. A screen reader reads the code
// as people write it, K7QX-M4PD; while there is none yet, the boxes' shapes
// stand in.

const box =
  "flex h-14.5 w-11.5 items-center justify-center rounded-md max-sm:h-11 max-sm:w-8";

function Boxes(props: { code: string | undefined }) {
  const characters = props.code ? [...props.code] : Array(8).fill("");
  const half = characters.length / 2;
  const boxes = (from: number) =>
    characters.slice(from, from + half).map((character, index) =>
      props.code ? (
        <span key={from + index} className={cn(box, "bg-foreground/11")}>
          {character}
        </span>
      ) : (
        <Skeleton key={from + index} className={cn(box, "rounded-md")} />
      ),
    );
  return (
    <span
      aria-hidden="true"
      className="flex items-center gap-2 text-[28px] leading-none font-normal tabular-nums max-sm:gap-1 max-sm:text-xl"
    >
      {boxes(0)}
      <span className="mx-1.5 h-0.5 w-3.5 rounded-xs bg-muted-foreground max-sm:mx-1" />
      {boxes(half)}
    </span>
  );
}

export function PairingCode(props: { code: string | undefined }) {
  return (
    <span className="flex flex-col items-center">
      <Boxes code={props.code} />
      {props.code && (
        <span className="sr-only">{formatPairingCode(props.code)}</span>
      )}
    </span>
  );
}

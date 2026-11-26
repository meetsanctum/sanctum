import {
  formatPairingCode,
  pairingCodeLength,
} from "@meetsanctum/auth-protocol";
import { cn } from "cn";

import { Skeleton } from "../components/ui/skeleton";

// One box per character makes the code easy to copy into the approval dialog.
// The boxes have no outline so they read as display text. Their shapes stand
// in while the device waits for a code.

const box =
  "flex h-14.5 w-11.5 items-center justify-center rounded-md max-sm:h-11 max-sm:w-8";
const placeholder = formatPairingCode(" ".repeat(pairingCodeLength));

export function PairingCode(props: { formattedCode: string | undefined }) {
  const [first, second] = (props.formattedCode ?? placeholder).split("-");
  const boxes = (group: string) =>
    [...group].map((character, index) =>
      props.formattedCode ? (
        <span key={index} className={cn(box, "bg-foreground/11")}>
          {character}
        </span>
      ) : (
        <Skeleton key={index} className={box} />
      ),
    );
  return (
    <span className="flex flex-col items-center">
      <span
        aria-hidden="true"
        data-slot="pairing-code"
        className="flex items-center gap-2 text-[28px] leading-none font-normal tabular-nums max-sm:gap-1 max-sm:text-xl"
      >
        {boxes(first!)}
        <span className="mx-1.5 h-0.5 w-3.5 rounded-xs bg-muted-foreground max-sm:mx-1" />
        {boxes(second!)}
      </span>
    </span>
  );
}

import { pairingCodeLength } from "@meetsanctum/auth-protocol";
import {
  InputOTPDisplay,
  InputOTPGroup,
  InputOTPSeparator,
  InputOTPSlot,
} from "@meetsanctum/ui-sdk";

// The code a shared device shows, in the very boxes the approving device
// types it into (Add a shared device), four and four with a dash between,
// so people copy it box by box. Empty boxes stand in while the device waits
// for a code. The page says the code in words for screen readers.

const half = pairingCodeLength / 2;
const first = Array.from({ length: half }, (_, index) => index);
const second = first.map((index) => index + half);

export function PairingCode(props: {
  code: string | undefined;
  length?: number;
}) {
  const length = props.length ?? pairingCodeLength;
  const extended = length > pairingCodeLength;
  return (
    <InputOTPDisplay
      data-slot="pairing-code"
      value={props.code ?? ""}
      maxLength={length}
      className={extended ? "w-100 max-w-full flex-col" : "w-100 max-w-full"}
    >
      <CodeSlots extended={extended} />
    </InputOTPDisplay>
  );
}

export function CodeSlots({ extended }: { extended: boolean }) {
  if (!extended) return <CodeRow offset={0} />;
  return (
    <>
      <div className="flex w-full items-center justify-center gap-2 max-sm:gap-1">
        <CodeRow offset={0} />
      </div>
      <div className="flex w-full items-center justify-center gap-2 max-sm:gap-1">
        <CodeRow offset={pairingCodeLength} />
      </div>
    </>
  );
}

function CodeRow({ offset }: { offset: number }) {
  return (
    <>
      <InputOTPGroup>
        {first.map((index) => (
          <InputOTPSlot key={index} index={offset + index} />
        ))}
      </InputOTPGroup>
      <InputOTPSeparator />
      <InputOTPGroup>
        {second.map((index) => (
          <InputOTPSlot key={index} index={offset + index} />
        ))}
      </InputOTPGroup>
    </>
  );
}

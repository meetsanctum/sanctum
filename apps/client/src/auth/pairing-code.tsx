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

export function PairingCode(props: { code: string | undefined }) {
  const length = props.code?.length ?? pairingCodeLength;
  return (
    <InputOTPDisplay
      data-slot="pairing-code"
      value={props.code ?? ""}
      maxLength={length}
      className={
        length > pairingCodeLength
          ? "w-100 max-w-full flex-col"
          : "w-100 max-w-full"
      }
    >
      <CodeSlots length={length} />
    </InputOTPDisplay>
  );
}

export function CodeSlots({ length }: { length: number }) {
  if (length === pairingCodeLength) return <CodeRow offset={0} />;
  return Array.from({ length: length / pairingCodeLength }, (_, row) => (
    <div
      key={row}
      className="flex w-full items-center justify-center gap-2 max-sm:gap-1"
    >
      <CodeRow offset={row * pairingCodeLength} />
    </div>
  ));
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

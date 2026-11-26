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
  return (
    <InputOTPDisplay
      data-slot="pairing-code"
      value={props.code ?? ""}
      maxLength={pairingCodeLength}
      className="w-100 max-w-full"
    >
      <InputOTPGroup>
        {first.map((index) => (
          <InputOTPSlot key={index} index={index} />
        ))}
      </InputOTPGroup>
      <InputOTPSeparator />
      <InputOTPGroup>
        {second.map((index) => (
          <InputOTPSlot key={index} index={index} />
        ))}
      </InputOTPGroup>
    </InputOTPDisplay>
  );
}

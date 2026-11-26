import { Button } from "@meetsanctum/ui-sdk";
import { ShieldAlert } from "lucide-react";

import { productName } from "../brand";
import { ChooseAnotherHome } from "../connection-veil";
import type { StoredHost } from "../shell";
import { Sheet, SheetActions } from "./sheet";

// The host answered with a certificate from another CA. The shell refused
// the connection before anything was sent, and this device cannot tell a
// host restored onto new hardware from an impostor, so both get the same
// check as a first contact: a personal device signs in again, a shared one
// shows a new pairing code. Nothing trusts a new certificate silently.
export function CertificateChanged(props: {
  host: StoredHost;
  onCheck: () => void;
  // The old certificate may be back, as when an impostor left.
  onRetry: () => void;
  // This host was forgotten, as after it was reset or replaced and has to be
  // set up again or chosen anew.
  onForgotten: () => void;
}) {
  const personal = props.host.kind === "personal";
  return (
    <Sheet
      glyph={ShieldAlert}
      warning
      title={`Check that this is ${props.host.name}`}
      subtitle="This home’s security certificate changed, so this device stopped before sending anything."
    >
      <div className="flex flex-col gap-2 text-center text-sm leading-5 text-muted-foreground">
        <p className="m-0">
          That’s expected after {productName} moves to new hardware. It can also
          mean another device is pretending to be your home.
        </p>
        <p className="m-0">
          {personal
            ? "Signing in again checks that it’s your home. Your password never leaves this device."
            : "Approving a new code from another device checks that it’s your home."}
        </p>
      </div>
      <SheetActions>
        <Button
          variant="default"
          size="lg"
          type="button"
          className="w-full"
          onClick={props.onCheck}
        >
          {personal ? "Sign in again" : "Show a new code"}
        </Button>
        <div className="flex flex-wrap justify-center gap-x-6 gap-y-2">
          <Button
            type="button"
            variant="link"
            size="inline"
            onClick={props.onRetry}
          >
            Check again
          </Button>
          <ChooseAnotherHome
            host={props.host}
            onForgotten={props.onForgotten}
            variant="link"
          />
        </div>
      </SheetActions>
    </Sheet>
  );
}

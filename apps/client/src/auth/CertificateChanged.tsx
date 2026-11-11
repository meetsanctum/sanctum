import { Button } from "@meetsanctum/ui-sdk";

import { productName } from "../brand";
import { Sheet } from "../components";
import { ChooseAnotherHome } from "../connection-veil";
import type { StoredHost } from "../shell";

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
      title="This home's security certificate changed"
      intro={
        <p className="muted">
          {props.host.name} answered with a certificate this device doesn't
          know, so nothing was sent to it. That happens after {productName} is
          restored onto new hardware, or when another device on the network
          pretends to be your home.
        </p>
      }
    >
      <p className="muted">
        {personal
          ? "Sign in again: your password checks that it is your home, and never leaves this device."
          : "Show a new pairing code, and someone checks it from another of the home's devices."}
      </p>
      <Button
        variant="default"
        size="lg"
        type="button"
        className="mt-1"
        onClick={props.onCheck}
      >
        {personal ? "Sign in again" : "Show a pairing code"}
      </Button>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Button
          type="button"
          variant="link"
          size="inline"
          onClick={props.onRetry}
        >
          Try again
        </Button>
        <ChooseAnotherHome
          host={props.host}
          onForgotten={props.onForgotten}
          variant="link"
        />
      </div>
    </Sheet>
  );
}

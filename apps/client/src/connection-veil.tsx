import { Button } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

import { forgetHost } from "./auth/session";
import { productName } from "./brand";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";
import type { StoredHost } from "./shell";
import { Veil } from "./veil";

// Connecting until the screen first reaches the home; found once the host
// has answered as itself, while its core is not up yet; away whenever the
// core stops answering after that; updating while an update restarts it;
// restarting, shutting down and off once someone restarted or shut down
// the machine from Status (power-notice.ts).
export type ConnectionState =
  | "connecting"
  | "found"
  | "away"
  | "updating"
  | "restarting"
  | "shuttingDown"
  | "off";

// How long the home may go unanswered before the veil says so and offers a
// way out. Connecting: three of the stored host's tries
// (src/auth/session.ts), so a host that is still starting or a device still
// joining the Wi-Fi passes unnoticed. Away: longer than the core is gone
// while an update restarts it, which counts afresh once the core reports
// the update, so it never shows during one. Restarting: a Pi taking long
// over starting again.
export const notAnsweringAfterMs = {
  connecting: 30_000,
  away: 120_000,
  restarting: 300_000,
};

// The connection veil covers the screen while it cannot reach the home:
// connecting until it first has, and away whenever the core stops answering
// after that. It keeps looking whatever happens here, and lifts once the
// home answers. During an update the core restarts on purpose, and it says
// that instead. After a while without an answer it says the home is not
// answering and offers to choose another home, for a host replaced by new
// hardware or a device that belongs to another home now; never during an
// update, nor once the host has answered as itself. A restart says so, and
// a shutdown how to start it again, which lifts once it answers.
export function ConnectionVeil(props: {
  state: ConnectionState;
  host: StoredHost;
  // The home answered with its own certificate, but it isn't valid now:
  // almost always a clock that is wrong.
  certificateNotValid?: boolean;
  onForgotten: () => void;
}) {
  const { state, host } = props;
  const [waited, setWaited] = useState(false);

  // Each state counts from its own start, so an update's restarts start the
  // count again.
  useEffect(() => {
    setWaited(false);
    if (state !== "connecting" && state !== "away" && state !== "restarting") {
      return;
    }
    const timer = window.setTimeout(
      () => setWaited(true),
      notAnsweringAfterMs[state],
    );
    return () => window.clearTimeout(timer);
  }, [state]);

  // Every state is the same veil, so it does not fade in again in between.
  if (state === "updating") {
    return (
      <Veil busy title="Updating">
        Your home is restarting with the new version. This screen comes back by
        itself.
      </Veil>
    );
  }
  if (state === "shuttingDown") {
    return (
      <Veil busy title="Shutting down">
        {productName} is shutting down. To start it again, unplug its power and
        plug it back in.
      </Veil>
    );
  }
  if (state === "off") {
    return (
      <Veil
        title={`${productName} is off`}
        action={
          <ChooseAnotherHome host={host} onForgotten={props.onForgotten} />
        }
      >
        To start it again, unplug its power and plug it back in. This screen
        comes back by itself.
      </Veil>
    );
  }
  if (state === "restarting" && !waited) {
    return (
      <Veil busy title="Restarting">
        {productName} is starting again. This takes about 2 minutes, and this
        screen comes back by itself.
      </Veil>
    );
  }
  if (props.certificateNotValid) {
    return (
      <Veil busy title="Your home's certificate isn't valid right now">
        {host.name} answered with its own certificate, but its dates don't fit
        this device's clock. Usually {productName}'s clock is wrong after a
        power cut: this screen comes back by itself once it is set from the
        internet. Also check this device's date and time.
      </Veil>
    );
  }
  if (waited) {
    return (
      <Veil
        busy
        title="Your home is not answering"
        action={
          <ChooseAnotherHome host={host} onForgotten={props.onForgotten} />
        }
      >
        Still looking for {host.name}. Check that this device is on your home{" "}
        <span className="whitespace-nowrap">Wi-Fi</span>. If your home was set
        up again, or this device belongs to another home now, choose that one
        instead.
      </Veil>
    );
  }
  return state === "away" ? (
    <Veil busy title="Reconnecting">
      Your home is not answering right now. This screen comes back by itself
      once it does.
    </Veil>
  ) : (
    <Veil busy title="Connecting">
      Looking for your home.
    </Veil>
  );
}

// Choosing another home forgets this one on the device alone, after a
// confirmation: the host cannot be reached to sign the device out, so its
// client stays in that host's Settings → Clients until someone removes it
// there. Shared devices get the same way out, since they have no account
// menu; forgetting leaves their client shared, and the device pairs again
// from the start.
export function ChooseAnotherHome(props: {
  host: StoredHost;
  onForgotten: () => void;
  // A link on a screen of its own (auth/CertificateChanged.tsx).
  variant?: "outline" | "link";
}) {
  const { host, onForgotten } = props;
  const [confirming, setConfirming] = useState(false);
  const [forgetting, setForgetting] = useState(false);
  const [problem, setProblem] = useState<string>();

  const forget = async () => {
    setForgetting(true);
    setProblem(undefined);
    try {
      await forgetHost(host);
    } catch {
      setProblem("That did not work. Try again.");
      setForgetting(false);
      return;
    }
    onForgotten();
  };

  return (
    <Dialog
      open={confirming}
      onOpenChange={(open) => {
        // Forgetting goes on once confirmed, so the dialog stays until then.
        if (forgetting) return;
        setConfirming(open);
        setProblem(undefined);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant={props.variant ?? "outline"}
          size={props.variant === "link" ? "inline" : "default"}
        >
          Choose another home
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Forget this home?</DialogTitle>
          <DialogDescription>
            This device stops looking for {host.name}, and you choose a home
            again. {host.name} cannot be reached to sign this device out, so the
            device stays listed in that home's{" "}
            <span className="whitespace-nowrap">Settings → Clients</span> until
            someone removes it there.
          </DialogDescription>
        </DialogHeader>
        {problem && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {problem}
          </p>
        )}
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={forgetting}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant="destructive"
            disabled={forgetting}
            onClick={() => void forget()}
          >
            Forget
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

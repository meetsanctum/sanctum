import { Button, Problem } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

import { productName } from "./brand";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { CoreError, coreJson } from "./core-fetch";
import { goneWithinMs } from "./power-notice";

// Restart and Shut down, at the end of System's Sanctum card, under Running
// for, which they reset. Each asks first, saying what happens and how to
// start it again; the confirming button names the result, and Cancel comes
// first. Once it is asked, every screen's veil says Restarting or Shutting
// down (connection-veil.tsx). While an update runs, both wait, dimmed,
// saying why; a request that can't go says so beside them.

export type PowerAction = "restart" | "shutdown";

const asked: Record<
  PowerAction,
  { title: string; text: string; button: string; failed: string }
> = {
  restart: {
    title: `Restart ${productName}?`,
    text: "It's away for about 2 minutes, then comes back by itself. Lights stay as they are, but remotes, motion and schedules wait until it's back.",
    button: "Restart",
    failed: `${productName} didn't restart`,
  },
  shutdown: {
    title: `Shut down ${productName}?`,
    text: "Remotes, motion and schedules stop, and no screen can reach your home until it's on again. To start it, unplug its power and plug it back in.",
    button: "Shut down",
    failed: `${productName} didn't shut down`,
  },
};

// Why it couldn't, and what to do.
function reasonOf(error: unknown) {
  const code = error instanceof CoreError ? error.code : undefined;
  if (code === "busy")
    return "An update or another change is under way. Try again once it has finished.";
  if (code === "manager_unavailable") {
    return `${productName}'s updater isn't answering. Try again in a minute.`;
  }
  return `${productName} didn't answer. Check that it's on, then try again.`;
}

export function PowerButtons(props: {
  updating: boolean;
  onPowerAccepted?: (action: PowerAction) => void;
}) {
  const { updating } = props;
  const [asking, setAsking] = useState<PowerAction>();
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<PowerAction>();
  const [problem, setProblem] = useState<{
    action: PowerAction;
    reason: string;
  }>();
  // What the dialog showed stays while it closes.
  const [shown, setShown] = useState<PowerAction>("restart");

  // A request the machine didn't act on can be made again, once the veil
  // has given up waiting for it (power-notice.ts).
  useEffect(() => {
    if (!sent) return;
    const timer = setTimeout(() => setSent(undefined), goneWithinMs);
    return () => clearTimeout(timer);
  }, [sent]);

  const confirm = async () => {
    if (!asking || updating || sending) return;
    const action = asking;
    setSending(true);
    setProblem(undefined);
    try {
      await coreJson<void>(`/api/system/${action}`, { method: "POST" });
      props.onPowerAccepted?.(action);
      setSent(action);
    } catch (error) {
      setProblem({ action, reason: reasonOf(error) });
    } finally {
      setSending(false);
      setAsking(undefined);
    }
  };

  const open = (action: PowerAction) => {
    setShown(action);
    setAsking(action);
  };

  return (
    <div className="flex flex-col gap-3">
      {updating && (
        <p className="m-0 text-[13px] font-medium text-muted-foreground">
          Restart and Shut down wait until the update has finished
        </p>
      )}
      {problem && !updating && (
        <Problem title={asked[problem.action].failed}>{problem.reason}</Problem>
      )}
      <div className="flex flex-wrap gap-2">
        {(["restart", "shutdown"] as const).map((action) => (
          <Button
            key={action}
            variant="outline"
            disabled={updating || sent !== undefined}
            onClick={() => open(action)}
          >
            {asked[action].button}
          </Button>
        ))}
      </div>
      <Dialog
        open={asking !== undefined}
        onOpenChange={(isOpen) => {
          // Once confirmed, it goes on, so the dialog stays until then.
          if (!isOpen && !sending) setAsking(undefined);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{asked[shown].title}</DialogTitle>
            <DialogDescription>{asked[shown].text}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={sending}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              disabled={sending || updating}
              onClick={() => void confirm()}
            >
              {asked[shown].button}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

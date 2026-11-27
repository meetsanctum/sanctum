import { Button } from "@meetsanctum/ui-sdk";
import { useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";

// An alert before something on a person's page that can't be taken back:
// it names what ends, focus starts on Cancel, and Return never presses the
// red button. A refusal shows in it, in the core's words made plain.

export type Asking = {
  title: string;
  description: string;
  confirm: string;
  // Where focus goes back to once it closes.
  trigger: HTMLButtonElement;
  // Does it; a throw keeps the alert open with what went wrong.
  run: () => Promise<void>;
  problem: (error: unknown) => string;
};

export function Confirm(props: {
  asking: Asking | undefined;
  onClose: () => void;
}) {
  // What it said stays while it closes.
  const last = useRef<Asking>(undefined);
  if (props.asking) last.current = props.asking;
  const asking = last.current;
  const [working, setWorking] = useState(false);
  const [problem, setProblem] = useState<string>();
  const [shown, setShown] = useState(props.asking);
  if (shown !== props.asking) {
    setShown(props.asking);
    setWorking(false);
    setProblem(undefined);
  }

  const run = async () => {
    if (!asking || working) return;
    setWorking(true);
    setProblem(undefined);
    try {
      await asking.run();
      props.onClose();
    } catch (error) {
      setProblem(asking.problem(error));
      setWorking(false);
    }
  };

  return (
    <Dialog
      open={!!props.asking}
      onOpenChange={(open) => {
        if (!open && !working) props.onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100vh-2rem)] grid-rows-[minmax(0,1fr)_auto] supports-[height:100dvh]:max-h-[calc(100dvh-2rem)]"
        onCloseAutoFocus={(event) => {
          if (!asking?.trigger.isConnected) return;
          event.preventDefault();
          asking.trigger.focus();
        }}
      >
        <div className="flex min-h-0 flex-col gap-6 overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{asking?.title}</DialogTitle>
            <DialogDescription>{asking?.description}</DialogDescription>
          </DialogHeader>
          {problem && (
            <p role="alert" className="m-0 text-sm text-destructive">
              {problem}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            autoFocus
            disabled={working}
            onClick={props.onClose}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={working}
            onClick={() => void run()}
          >
            {asking?.confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

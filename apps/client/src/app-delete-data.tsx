import type { AvailableApp } from "@meetsanctum/app-sdk";
import { Button, Problem } from "@meetsanctum/ui-sdk";
import { useState } from "react";

import { productName } from "./brand";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./components/ui/dialog";
import { CoreError, coreJson } from "./core-fetch";
import { possessive } from "./frames/use-frame";
import { problemReason } from "./device-parts";

// Deleting a removed app's data at once, rather than once its 30 days are
// over, from its row under Add apps. Nothing brings it back, so it asks first,
// saying what goes and what adding it back then means; Cancel is focused, and
// focus goes back to the button once it closes. A deletion that fails part
// way may have deleted some already, so its words say so.

/** What deleting it takes, in a sentence or two. */
export function deletingWords(app: AvailableApp) {
  const words = app.adds.devices
    ? "Its devices, their history and its settings are deleted, so adding it back means adding every device again."
    : "Its settings and what it saved are deleted, so adding it back starts it afresh.";
  // A service's data goes only when no other app uses it, which this sheet
  // can't tell: a driver's network, as Zigbee2MQTT holds it, or Ollama's
  // models.
  const notices = [words];
  if (
    app.adds.devices &&
    app.requests.some((request) => request.id === "services:zigbee2mqtt")
  ) {
    notices.push(
      `Unless another app uses its network, that's erased too, so every ${app.name} device has to be paired again.`,
    );
  }
  if (app.requests.some((request) => request.id === "services:ollama")) {
    notices.push(
      "Unless another app uses Ollama, its downloaded models are deleted too.",
    );
  }
  return notices.join(" ");
}

export function DeleteAppData(props: {
  app: AvailableApp;
  /** It's gone, as the core answered. */
  onDeleted: () => void;
}) {
  const { app } = props;
  const [isAsking, setIsAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const failed = `${possessive(app.name)} data wasn't all deleted`;

  const remove = async () => {
    setPending(true);
    setProblem(undefined);
    try {
      await coreJson(`/api/apps/${encodeURIComponent(app.id)}/data/delete`, {
        method: "POST",
        json: {},
      });
      setIsAsking(false);
      props.onDeleted();
    } catch (error) {
      setIsAsking(false);
      const code = error instanceof CoreError ? error.code : null;
      setProblem(
        code === "unavailable"
          ? `Some may already be gone. ${productName} can't delete the rest right now: check for an update, then try again.`
          : `Some may already be gone. ${problemReason(error)}`,
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <Dialog
        open={isAsking}
        onOpenChange={(open) => {
          if (open) {
            setProblem(undefined);
            setIsAsking(true);
          } else if (!pending) {
            setIsAsking(false);
          }
        }}
      >
        <DialogTrigger asChild>
          <Button variant="destructive" size="sm">
            Delete {app.name}'s data now
          </Button>
        </DialogTrigger>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Delete {app.name}'s data?</DialogTitle>
            <DialogDescription>{deletingWords(app)}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              autoFocus
              disabled={pending}
              onClick={() => setIsAsking(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => void remove()}
            >
              {pending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {problem && <Problem title={failed}>{problem}</Problem>}
    </div>
  );
}

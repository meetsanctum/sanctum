import type { AvailableApp } from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { useState } from "react";

import { productName } from "./brand";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { CoreError, coreJson } from "./core-fetch";

// Deleting a removed app's data at once, rather than once its 30 days are
// over, from its row under Add apps. Nothing brings it back, so it asks first,
// saying what goes and what adding it back then means; Cancel is focused.

/** What deleting it takes, in a sentence or two. */
export function deletingWords(app: AvailableApp) {
  const words = app.adds.devices
    ? "Its devices, their history and its settings are deleted, so adding it back means adding every device again."
    : "Its settings and what it saved are deleted, so adding it back starts it afresh.";
  // A service of its own holds a driver's network, as Zigbee2MQTT does.
  const hasNetwork = app.requests.some((request) =>
    request.id.startsWith("services:"),
  );
  return hasNetwork
    ? `${words} Its network is erased too, so every ${app.name} device has to be paired again.`
    : words;
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
          ? `${productName} can't delete ${app.name}'s data right now. Try again or check for an update.`
          : `${app.name}'s data couldn't be deleted. Try again.`,
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="destructive"
        size="sm"
        onClick={() => {
          setProblem(undefined);
          setIsAsking(true);
        }}
      >
        Delete {app.name}'s data now
      </Button>
      {problem && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {problem}
        </p>
      )}
      <Dialog
        open={isAsking}
        onOpenChange={(open) => {
          if (!open && !pending) setIsAsking(false);
        }}
      >
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
    </div>
  );
}

import type { AppInfo, AppRemoval } from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { useState } from "react";
import { list } from "@meetsanctum/app-sdk/words";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { CoreError, coreJson } from "./core-fetch";

// Removing an app, at the end of its settings, after Turn off. It takes the
// app and all it brings from every screen in the home, so it asks first,
// once the core has said what goes: a driver's devices, the automations that
// use it, which turn off, and its widgets and room sections. Cancel is
// focused. Its own data is kept for 30 days, so adding it back meanwhile
// brings back what it had. System apps have no Remove.

/** What goes with it, in a sentence or two, for its dialog. */
export function removalWords(app: AppInfo, removal: AppRemoval) {
  const lines: string[] = [];
  if (removal.devices === 1) lines.push("Its device leaves your home.");
  if (removal.devices > 1) {
    lines.push(`Its ${removal.devices} devices leave your home.`);
  }
  if (removal.widgets === 1) lines.push("Its widget leaves Home.");
  if (removal.widgets > 1) {
    lines.push(`Its ${removal.widgets} widgets leave Home.`);
  }
  if (removal.roomSections > 0) lines.push("What it shows in rooms goes too.");
  const names = removal.workflows.map((workflow) => workflow.name);
  const one = names.length === 1;
  const automations =
    names.length === 0
      ? null
      : {
          title: `${names.length} ${one ? "automation uses" : "automations use"} it:`,
          line: `${list("en", names)}. ${one ? "It turns" : "They turn"} off and ${one ? "says" : "say"} ${app.name} is missing.`,
        };
  const back =
    removal.devices > 0
      ? "If you add it back within 30 days, its devices, their rooms and history and its settings come back as they were."
      : "If you add it back within 30 days, its settings come back as they were.";
  return { lines, automations, back };
}

export function RemoveApp(props: {
  app: AppInfo;
  /** It's gone, as the core answered. */
  onRemoved: () => void;
}) {
  const { app } = props;
  const [removal, setRemoval] = useState<AppRemoval>();
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const path = `/api/apps/${encodeURIComponent(app.id)}`;

  const ask = () => {
    setProblem(undefined);
    coreJson<AppRemoval>(`${path}/removal`).then(setRemoval, () =>
      setProblem(`${app.name} can't be removed now. Try again.`),
    );
  };
  const remove = async () => {
    setPending(true);
    setProblem(undefined);
    try {
      await coreJson(`${path}/remove`, { method: "POST", json: {} });
      setRemoval(undefined);
      props.onRemoved();
    } catch (error) {
      setRemoval(undefined);
      setProblem(
        error instanceof CoreError && error.code === "conflict"
          ? `${app.name} is changing version. Try again once it's done.`
          : `${app.name} couldn't be removed. Try again.`,
      );
    } finally {
      setPending(false);
    }
  };

  const words = removal && removalWords(app, removal);
  return (
    <div className="flex shrink-0 flex-col items-start gap-2">
      <Button variant="destructive" onClick={ask}>
        Remove {app.name}
      </Button>
      {problem && (
        <p role="alert" className="m-0 text-sm text-destructive">
          {problem}
        </p>
      )}
      <Dialog
        open={removal !== undefined}
        onOpenChange={(open) => {
          if (!open && !pending) setRemoval(undefined);
        }}
      >
        {words && (
          <DialogContent
            showCloseButton={false}
            className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
          >
            <DialogHeader>
              <DialogTitle>Remove {app.name}?</DialogTitle>
              <DialogDescription asChild>
                <div className="flex flex-col gap-3">
                  {words.lines.length > 0 && (
                    <p className="m-0 text-foreground">
                      {words.lines.join(" ")}
                    </p>
                  )}
                  {words.automations && (
                    <p className="m-0 rounded-md bg-muted px-3 py-2.5 text-foreground">
                      <span className="font-medium">
                        {words.automations.title}
                      </span>{" "}
                      {words.automations.line}
                    </p>
                  )}
                  <p className="m-0">{words.back}</p>
                </div>
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                autoFocus
                disabled={pending}
                onClick={() => setRemoval(undefined)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                disabled={pending}
                onClick={() => void remove()}
              >
                {pending ? "Removing…" : "Remove"}
              </Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}

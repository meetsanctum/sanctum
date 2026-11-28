import type { AppGoBack, AppInfo } from "@meetsanctum/app-sdk";
import type { HomeClock } from "@meetsanctum/app-sdk/clock";
import { Button, Problem, useHomeClock } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import { coreJson } from "./core-fetch";
import { problemReason } from "./device-parts";

// Going back from an app's last update, at the end of its settings. It loses
// what the app has saved since, so it asks first, saying so; Cancel is
// focused. It's offered while the old copy and package are there, which only
// the home knows, and not while the app is off, paused or between versions.

/** "2 November" */
export const dayWords = (clock: HomeClock, at: string) =>
  clock.longDayText(new Date(at));

/** What going back asks about: what's lost, what stays and how long it lasts. */
export function goingBackWords(clock: HomeClock, app: AppInfo, to: AppGoBack) {
  return `Its data returns to how it was before the update on ${dayWords(clock, to.since)}, so anything it has saved since is lost, and automations that use it may need changing. Settings you've chosen stay where ${to.version} can use them. It stays on ${to.version} until a version newer than ${app.version} arrives.`;
}

export const canGoBack = (app: AppInfo) => {
  const stage = app.run?.update?.stage;
  if (stage === "updating" || stage === "goingBack") return false;
  return (
    app.state === "running" ||
    app.state === "waiting" ||
    app.state === "restarting" ||
    app.state === "failed" ||
    app.state === "stopped"
  );
};

const pathOf = (app: AppInfo) =>
  `/api/apps/${encodeURIComponent(app.id)}/go-back`;

/** What going back from its last update would return to, if anything. */
export function useGoBackTo(app: AppInfo) {
  const [to, setTo] = useState<AppGoBack | null>(null);
  const path = pathOf(app);
  // Asked again as its state or version changes, or an update of it ends.
  const stage = app.run?.update?.stage;
  useEffect(() => {
    let isCurrent = true;
    coreJson<{ to: AppGoBack | null }>(path)
      .then((next) => {
        if (isCurrent) setTo(next.to);
      })
      .catch(() => {
        if (isCurrent) setTo(null);
      });
    return () => {
      isCurrent = false;
    };
  }, [path, app.state, app.version, stage]);
  return to;
}

export function GoBack(props: { app: AppInfo; to: AppGoBack | null }) {
  const clock = useHomeClock();
  const { app, to } = props;
  const [isAsking, setIsAsking] = useState(false);
  const [problem, setProblem] = useState<string>();
  const failed = `${app.name} didn't go back to ${to?.version}`;
  const path = pathOf(app);
  if (!to || !canGoBack(app)) return null;
  const goBack = () => {
    setIsAsking(false);
    setProblem(undefined);
    // What it says next arrives as it changes, as any app's does.
    coreJson(path, { method: "POST", json: { id: to.id } }).catch(
      (error: unknown) => setProblem(problemReason(error)),
    );
  };
  return (
    <div className="flex shrink-0 flex-col items-start gap-2">
      <Button variant="outline" onClick={() => setIsAsking(true)}>
        Go back to {to.version}
      </Button>
      {problem && <Problem title={failed}>{problem}</Problem>}
      <Dialog open={isAsking} onOpenChange={setIsAsking}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              Go back to {app.name} {to.version}?
            </DialogTitle>
            <DialogDescription>
              {goingBackWords(clock, app, to)}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              autoFocus
              onClick={() => setIsAsking(false)}
            >
              Cancel
            </Button>
            <Button onClick={goBack}>Go back</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

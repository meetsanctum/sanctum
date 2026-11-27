import {
  permissionWords,
  type AppInfo,
  type AppWaitingUpdate,
} from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import { CircleAlert, Info } from "lucide-react";
import { useState } from "react";
import { list } from "@meetsanctum/app-sdk/words";

import { Asks } from "./add-app-sheet";
import { NoticeCard } from "./app-state";
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

// A newer version of an app that needs a permission the household hasn't
// granted waits for someone to allow it, the app on the version it has. Its
// settings say so with Review, and so does Needs attention, plainly, since
// nothing is broken. Review shows only what's new: Update grants it and starts
// the update, and Not now changes nothing and isn't remembered. When the
// version the app ran can't run on this Sanctum, the app is on the new one,
// stopped until someone allows it, which is a problem, in red. One that needs
// more memory than is left waits for room instead, with nothing to allow: it
// says how much, and starts by itself once there's room.

/** Whether it waits for room, rather than for someone to allow it. */
export const waitsForRoom = (waiting: AppWaitingUpdate) =>
  waiting.needs.length === 0 && waiting.moreMemoryMb !== undefined;

/** Whether it's stopped on the version that waits, rather than running the one before. */
export const isStoppedFor = (app: AppInfo, waiting: AppWaitingUpdate) =>
  app.build === waiting.build;

// "see your lights and control your switches"
function needsList(waiting: AppWaitingUpdate) {
  const titles = waiting.needs.map((request) => {
    const title = permissionWords(request.id).title;
    return title.charAt(0).toLowerCase() + title.slice(1);
  });
  return list("en", titles);
}

/** What its notice says, and Needs attention's line. */
export function waitingNoticeWords(app: AppInfo, waiting: AppWaitingUpdate) {
  if (waitsForRoom(waiting)) {
    return {
      title: `${app.name} ${waiting.version} is waiting`,
      line: `It needs ${waiting.moreMemoryMb} MB more memory. Turning off an app you don't use makes room.`,
    };
  }
  if (isStoppedFor(app, waiting)) {
    return {
      title: `${app.name} can't run on this ${productName}`,
      // Allowing it doesn't turn on one someone turned off.
      line:
        app.state === "off"
          ? `Allow ${waiting.version} so it can run. It needs to ${needsList(waiting)}.`
          : `Allow ${waiting.version} to start it again. It needs to ${needsList(waiting)}.`,
    };
  }
  return {
    title: `${app.name} ${waiting.version} is waiting`,
    line: `It needs to ${needsList(waiting)}. ${app.name} stays on ${app.version} until someone allows it.`,
  };
}

/** Needs attention's line for one that waits. */
export function waitingAttentionText(app: AppInfo, waiting: AppWaitingUpdate) {
  if (waitsForRoom(waiting)) {
    return `${waiting.version} is waiting: it needs ${waiting.moreMemoryMb} MB more memory`;
  }
  return isStoppedFor(app, waiting)
    ? `Can't run on this ${productName}: allow ${waiting.version} to start it again`
    : `${waiting.version} is waiting: it needs to ${needsList(waiting)}`;
}

/** Review, and the sheet it opens: what the version that waits newly needs. */
export function ReviewUpdate(props: {
  app: AppInfo;
  waiting: AppWaitingUpdate;
  size?: "sm";
  variant?: "default" | "outline";
}) {
  const { app, waiting } = props;
  const [isAsking, setIsAsking] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string>();
  const stopped = isStoppedFor(app, waiting);
  const many = waiting.needs.length > 1;

  const allow = async () => {
    setPending(true);
    setProblem(undefined);
    try {
      // What it says next arrives as it changes, as any app's does.
      await coreJson(`/api/apps/${encodeURIComponent(app.id)}/update/allow`, {
        method: "POST",
        json: { id: waiting.id },
      });
      setIsAsking(false);
    } catch (error) {
      setProblem(
        error instanceof CoreError && error.code === "conflict"
          ? `${app.name} changed meanwhile, as when it was allowed on another device. Close this and look again.`
          : "That did not work. Try again.",
      );
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open={isAsking}
      onOpenChange={(open) => {
        if (pending) return;
        setProblem(undefined);
        setIsAsking(open);
      }}
    >
      <DialogTrigger asChild>
        <Button
          variant={props.variant ?? "default"}
          {...(props.size ? { size: props.size } : {})}
        >
          Review
        </Button>
      </DialogTrigger>
      {/* A long list scrolls within the screen, Update with it. */}
      <DialogContent
        showCloseButton={false}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>
            {stopped
              ? `Start ${app.name} ${waiting.version}?`
              : `Update ${app.name} to ${waiting.version}?`}
          </DialogTitle>
          <DialogDescription>
            {stopped
              ? `It needs ${many ? "these" : "this"} to work:`
              : `The new version also needs ${many ? "these" : "this"} to work:`}
          </DialogDescription>
        </DialogHeader>
        <Asks requests={waiting.needs} />
        <p className="m-0 text-sm text-muted-foreground">
          {stopped ? "" : "Everything it may do now stays as it is. "}
          Turning {many ? "these" : "this"} off later pauses {app.name}.
        </p>
        {problem && (
          <p role="alert" className="m-0 text-sm text-destructive">
            {problem}
          </p>
        )}
        <DialogFooter>
          <Button
            variant="outline"
            autoFocus
            disabled={pending}
            onClick={() => setIsAsking(false)}
          >
            Not now
          </Button>
          <Button disabled={pending} onClick={() => void allow()}>
            {stopped ? "Allow" : "Update"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** In its settings: the version that waits, with Review. */
export function UpdateWaiting(props: { app: AppInfo }) {
  const { app } = props;
  const waiting = app.waiting;
  if (!waiting) return null;
  const { title, line } = waitingNoticeWords(app, waiting);
  return (
    <NoticeCard
      Icon={isStoppedFor(app, waiting) ? CircleAlert : Info}
      isWrong={isStoppedFor(app, waiting)}
      title={title}
      line={line}
      action={
        waitsForRoom(waiting) ? undefined : (
          <ReviewUpdate app={app} waiting={waiting} />
        )
      }
    />
  );
}

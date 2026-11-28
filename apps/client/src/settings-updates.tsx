import type { HomeClock } from "@meetsanctum/app-sdk/clock";
import { Button, Problem, useHomeClock } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { Check, ChevronDown, Circle, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { productName } from "./brand";
import { Section } from "./components";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./components/ui/collapsible";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./components/ui/dialog";
import type { CoreStatus } from "./core-status";
import { Fact, Facts } from "./settings-status-facts";
import {
  channelNames,
  isAway,
  problemText,
  systemUpdate,
  type AvailableVersion,
  type RestoreInfo,
  type UpdateInfo,
  type UpdateStatus,
  type UpdateStep,
} from "./system-update";
import { isShown } from "./while-shown";

// System's Updates, for every client (settings-status.tsx): the core's
// running version, the last update, and the versions the host can update to; on
// the dev channel its builds, folded under a row that names the one chosen,
// then a confirmed Update, the update's progress as the manager reports it
// and how it ended. The core restarts during an update; meanwhile the
// connection veil covers the page, and the progress carries on when the
// core is back. The last restore from a backup is said in Sanctum's card.

// A day and a time on the home clock: "25 Nov, 14:03".
const dayAndTime = (clock: HomeClock, at: Date) =>
  `${clock.dayText(at)}, ${clock.timeText(at)}`;

export function UpdatesSection(props: {
  core: CoreStatus;
  system: ReturnType<typeof useSystemUpdate>;
  freeing: boolean;
  cleanupRevision: number;
}) {
  const { core } = props;
  const version =
    core.state === "online" || core.state === "updating"
      ? core.version
      : undefined;
  return (
    <Section id="status-updates" title="Updates">
      <Updates
        online={core.state === "online"}
        version={version}
        system={props.system}
        freeing={props.freeing}
        cleanupRevision={props.cleanupRevision}
      />
    </Section>
  );
}

// After a restore from a backup every device was signed out; the first to
// look is told what that means.
export function RestoreNotice(props: { online: boolean }) {
  const clock = useHomeClock();
  const [restore, setRestore] = useState<RestoreInfo | null>(null);

  useEffect(() => {
    if (!props.online) return;
    let isCurrent = true;
    systemUpdate
      .restore()
      .then((answer) => isCurrent && setRestore(answer.restore))
      .catch(() => undefined);
    return () => {
      isCurrent = false;
    };
  }, [props.online]);

  if (!restore) return null;
  const date =
    restore.backupAt && clock.longDayText(new Date(restore.backupAt));
  return (
    <div className="flex flex-col items-start gap-3 rounded-lg border border-(--hairline) p-4">
      <p className="m-0 text-sm">
        {date ? `Restored to ${date}.` : "Restored from a backup."} All devices
        were signed out. People and passwords are as of
        {date ? " that date" : " the backup"}. Check them.
      </p>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setRestore(null);
          void systemUpdate.dismissRestore().catch(() => undefined);
        }}
      >
        Dismiss
      </Button>
    </div>
  );
}

export function useSystemUpdate(online: boolean) {
  const [status, setStatus] = useState<UpdateStatus>();
  // The last answer was that the core or the manager is restarting.
  const [isWaiting, setIsWaiting] = useState(false);
  // An update this screen has seen running, whose ending it shows in full.
  const [followed, setFollowed] = useState<string>();
  const statusRevision = useRef(0);

  const update = status?.update ?? null;
  const running = !!update && update.step !== "done";

  // The update's status, often while one runs. While the core is away the
  // veil covers this page; it asks again as soon as the core is back.
  useEffect(() => {
    if (!online) return;
    let isStopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let next = isShown() ? 10_000 : 30_000;
      const revision = statusRevision.current;
      try {
        const answer = await systemUpdate.status();
        if (isStopped) return;
        // A status requested before an accepted start must not erase it.
        if (revision === statusRevision.current) {
          setStatus(answer);
          setIsWaiting(false);
          if (answer.update && answer.update.step !== "done") {
            setFollowed(answer.update.id);
            next = 1_500;
          }
        }
      } catch (error) {
        if (isStopped) return;
        if (revision === statusRevision.current) setIsWaiting(isAway(error));
        next = 2_000;
      }
      if (revision !== statusRevision.current) next = 1_500;
      timer = setTimeout(poll, next);
    };
    void poll();
    return () => {
      isStopped = true;
      clearTimeout(timer);
    };
  }, [online, running]);

  const ended = update?.step === "done" ? update.id : undefined;
  const followStart = (started: UpdateInfo) => {
    statusRevision.current += 1;
    setStatus((current) => current && { ...current, update: started });
    setFollowed(started.id);
  };
  return { status, update, running, ended, followed, isWaiting, followStart };
}

function Updates(props: {
  online: boolean;
  // The version the core's health check reports, while it answers.
  version?: string;
  system: ReturnType<typeof useSystemUpdate>;
  freeing: boolean;
  cleanupRevision: number;
}) {
  const { online, freeing, cleanupRevision } = props;
  const { status, update, running, ended, followed, isWaiting, followStart } =
    props.system;
  const coreVersion = props.version ?? status?.version;
  const [builds, setBuilds] = useState<{
    versions: AvailableVersion[];
    cleanupRevision: number;
    ended: string | undefined;
  }>();
  const [selected, setSelected] = useState<string>();
  const [confirming, setConfirming] = useState<string>();
  const [starting, setStarting] = useState(false);
  const [versionsProblem, setVersionsProblem] = useState<string>();
  const [updateProblem, setUpdateProblem] = useState<string>();

  // What the host can update to. Cleanup can remove builds from the registry.
  useEffect(() => {
    if (!online || freeing) return;
    let isCurrent = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const answer = await systemUpdate.versions();
        if (!isCurrent) return;
        setBuilds({ versions: answer.versions, cleanupRevision, ended });
        setSelected((current) =>
          answer.versions.some(({ version }) => version === current)
            ? current
            : undefined,
        );
        setVersionsProblem(undefined);
      } catch (error) {
        if (!isCurrent) return;
        const away = isAway(error);
        setVersionsProblem(
          away
            ? `${productName} didn't answer. It asks again every few seconds.`
            : problemText(error),
        );
        if (away) timer = setTimeout(load, 2_000);
      }
    };
    void load();
    return () => {
      isCurrent = false;
      clearTimeout(timer);
    };
  }, [online, ended, freeing, cleanupRevision]);

  // The newest build, when it is newer than the one the host runs and is not
  // the one that just failed, until someone chooses.
  const choices = builds?.versions ?? [];
  const isDev = status?.channel === "dev";
  const newest = choices[0]?.version;
  const failed =
    update?.outcome === "rolled-back" || update?.outcome === "failed"
      ? update.version
      : undefined;
  const choice = isDev
    ? (selected ??
      (newest !== coreVersion && newest !== failed ? newest : undefined))
    : status?.channel;
  const canUpdate =
    online &&
    !freeing &&
    !running &&
    !starting &&
    !!choice &&
    (!isDev ||
      (choice !== coreVersion &&
        builds?.cleanupRevision === cleanupRevision &&
        builds.ended === ended));

  const start = async () => {
    if (!canUpdate || !confirming || confirming !== choice) return;
    setStarting(true);
    setUpdateProblem(undefined);
    try {
      const { update: started } = await systemUpdate.start(confirming);
      followStart(started);
      setSelected(undefined);
    } catch (error) {
      setUpdateProblem(problemText(error));
    } finally {
      setStarting(false);
      setConfirming(undefined);
    }
  };

  if (!status) {
    return (
      <>
        <Facts>
          <Fact label="Version">{coreVersion ?? "Not known right now"}</Fact>
        </Facts>
        {isWaiting && (
          <p className="m-0 text-[13px] text-muted-foreground">
            Waiting for {productName} to answer…
          </p>
        )}
      </>
    );
  }

  // The last update, ended before this screen opened.
  const lastUpdate =
    update && !running && update.id !== followed ? update : undefined;
  // The core that answers runs the new version, and the manager is away:
  // it is replacing itself, the last step.
  const step: UpdateStep =
    update && running && isWaiting && coreVersion === update.version
      ? "finish"
      : (update?.step ?? "done");

  return (
    <>
      <Facts>
        <Fact label="Version">
          {`${coreVersion ?? status.version} · ${channelNames[status.channel]}`}
        </Fact>
        {lastUpdate && <LastUpdate update={lastUpdate} />}
      </Facts>
      {lastUpdate && <WhyItFailed update={lastUpdate} />}
      {update && (running || update.id === followed) && (
        <Progress update={update} step={step} />
      )}
      {!running && (
        <>
          {status.channel === "dev" ? (
            // Until the builds are read, nothing is known about them.
            builds && (
              <VersionPicker
                versions={choices}
                running={coreVersion}
                selected={choice}
                onSelect={setSelected}
              />
            )
          ) : (
            <p className="m-0 text-sm">
              Updates to the newest {status.channel} release.
            </p>
          )}
          <Button
            className="self-start"
            disabled={!canUpdate}
            onClick={() => setConfirming(choice)}
          >
            {status.channel === "dev" && choice
              ? `Update to ${choice}`
              : "Update"}
          </Button>
        </>
      )}
      {updateProblem ? (
        <Problem title="The update didn't start">{updateProblem}</Problem>
      ) : (
        isDev &&
        versionsProblem && (
          <Problem title="Versions didn't load">{versionsProblem}</Problem>
        )
      )}
      <Dialog
        open={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {status.channel === "dev"
                ? `Update to ${confirming}?`
                : `Update to the newest ${status.channel} release?`}
            </DialogTitle>
            <DialogDescription>
              Your home backs up its data, then restarts with the new version.
              Its controls are unavailable for a minute or two. If the new
              version does not start, your home goes back to{" "}
              {coreVersion ?? "this one"} by itself.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button
              disabled={!canUpdate || confirming !== choice}
              onClick={() => void start()}
            >
              Update
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

const steps: Array<[UpdateStep, (update: UpdateInfo) => string]> = [
  ["download", (update) => `Downloading ${update.version}`],
  ["backup", () => "Backing up your home's data"],
  ["restart", () => "Starting the new version"],
  ["check", () => "Checking that it works"],
  ["finish", () => "Finishing"],
];

// An update this screen follows: its steps while it runs, then how it ended.
function Progress(props: { update: UpdateInfo; step: UpdateStep }) {
  const { update, step } = props;
  if (step === "done") {
    return <Outcome update={update} />;
  }
  // A rollback follows the check that failed.
  const current =
    step === "rollback"
      ? steps.findIndex(([name]) => name === "check")
      : steps.findIndex(([name]) => name === step);
  return (
    <div role="status" className="flex flex-col gap-2">
      <p className="m-0 text-sm font-medium">Updating to {update.version}</p>
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
        {steps.map(([name, label], index) => (
          <StepLine
            key={name}
            label={label(update)}
            state={
              index < current || (step === "rollback" && index === current)
                ? "done"
                : index === current
                  ? "current"
                  : "later"
            }
          />
        ))}
        {step === "rollback" && (
          <StepLine
            label={`Going back to ${update.from ?? "the previous version"}`}
            state="current"
          />
        )}
      </ol>
    </div>
  );
}

function StepLine(props: {
  label: string;
  state: "done" | "current" | "later";
}) {
  const Icon =
    props.state === "done"
      ? Check
      : props.state === "current"
        ? LoaderCircle
        : Circle;
  return (
    <li
      className={cn(
        "flex items-center gap-2 text-sm",
        props.state === "later" && "text-muted-foreground",
      )}
      aria-current={props.state === "current" ? "step" : undefined}
    >
      <Icon
        aria-hidden="true"
        className={cn(
          "size-4 shrink-0",
          props.state === "current" && "animate-spin",
          props.state === "later" && "size-3 m-0.5",
        )}
      />
      {props.label}
    </li>
  );
}

// A version's name, kept on one line.
function Version(props: { name: string }) {
  return <span className="whitespace-nowrap">{props.name}</span>;
}

function outcomeText(update: UpdateInfo): {
  title: string;
  detail?: ReactNode;
} {
  switch (update.outcome) {
    case "updated":
      return { title: `Updated to ${update.version}`, detail: undefined };
    case "unchanged":
      return { title: "Already up to date", detail: undefined };
    case "rolled-back":
      return {
        title: "The update was rolled back",
        detail: (
          <>
            <Version name={update.version} /> did not start, so your home went
            back to{" "}
            {update.from ? (
              <Version name={update.from} />
            ) : (
              "the version it had"
            )}
            .
          </>
        ),
      };
    default:
      return {
        title: "The update did not finish",
        detail: undefined,
      };
  }
}

// How an update this screen followed ended, and why when it did not work.
function Outcome(props: { update: UpdateInfo }) {
  const { update } = props;
  const { title, detail } = outcomeText(update);
  const failed =
    update.outcome === "rolled-back" || update.outcome === "failed";
  return (
    <div role="status" className="flex flex-col gap-1">
      <p className="m-0 text-sm font-medium">{title}</p>
      {detail && <p className="m-0 text-sm">{detail}</p>}
      {failed && update.error && (
        <p className="m-0 text-[13px] break-words text-muted-foreground">
          Reason: {update.error}
        </p>
      )}
    </div>
  );
}

// The last update, ended before this screen opened, as one of the card's
// facts.
function LastUpdate(props: { update: UpdateInfo }) {
  const { update } = props;
  const clock = useHomeClock();
  const { title } = outcomeText(update);
  const when = update.finishedAt ?? update.startedAt;
  return (
    <Fact label="Last update">
      {title} · {dayAndTime(clock, new Date(when))}
    </Fact>
  );
}

// Why that update did not work, under the facts.
function WhyItFailed(props: { update: UpdateInfo }) {
  const { update } = props;
  const failed =
    update.outcome === "rolled-back" || update.outcome === "failed";
  if (!failed || !update.error) return null;
  return (
    <p className="m-0 text-[13px] break-words text-muted-foreground">
      Reason: {update.error}
    </p>
  );
}

// A dev host's builds, newest first, folded under a row that says which is
// chosen and how many there are; the one it runs cannot be chosen.
function VersionPicker(props: {
  versions: AvailableVersion[];
  running?: string;
  selected?: string;
  onSelect: (version: string) => void;
}) {
  const clock = useHomeClock();
  if (props.versions.length === 0) {
    return (
      <p className="m-0 text-sm">
        No builds yet. Publish one to the dev registry first.
      </p>
    );
  }
  const count =
    props.versions.length === 1 ? "1 build" : `${props.versions.length} builds`;
  return (
    <Collapsible className="flex flex-col gap-1">
      <CollapsibleTrigger asChild>
        <Button
          variant="row"
          size="row"
          type="button"
          className="group -mx-2.5 w-[calc(100%+20px)]"
        >
          <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
            <span className="truncate text-sm font-medium">Builds</span>
            <span className="truncate text-[13px] font-medium text-muted-foreground">
              {props.selected
                ? `${props.selected} chosen · ${count}`
                : `None chosen · ${count}`}
            </span>
          </span>
          <ChevronDown
            aria-hidden="true"
            className="ms-auto size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
          />
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
          <legend className="sr-only">Build to update to</legend>
          {props.versions.map(({ version, builtAt }) => {
            const isRunning = version === props.running;
            const isChosen = props.selected === version;
            const detail = [
              builtAt && `Built ${dayAndTime(clock, new Date(builtAt))}`,
              isRunning && "Running",
            ]
              .filter(Boolean)
              .join(" · ");
            return (
              <label
                key={version}
                className={cn(
                  "flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 has-checked:bg-foreground has-checked:text-background",
                  isRunning && "cursor-default text-muted-foreground",
                )}
              >
                <input
                  type="radio"
                  name="version"
                  value={version}
                  checked={isChosen}
                  disabled={isRunning}
                  onChange={() => props.onSelect(version)}
                  className="sr-only"
                />
                <span className="flex min-w-0 items-center gap-1.5">
                  {isChosen && (
                    <Check
                      aria-hidden="true"
                      className="size-3.5 shrink-0"
                      strokeWidth={2.5}
                    />
                  )}
                  <span className="truncate text-sm font-medium">
                    {version}
                  </span>
                </span>
                <span
                  className={cn(
                    "shrink-0 text-[13px]",
                    !isRunning && "opacity-65",
                  )}
                >
                  {detail}
                </span>
              </label>
            );
          })}
        </fieldset>
      </CollapsibleContent>
    </Collapsible>
  );
}

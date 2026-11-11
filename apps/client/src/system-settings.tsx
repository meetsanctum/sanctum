import { Button } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import { Check, Circle, LoaderCircle } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { productName } from "./brand";
import { Row } from "./components";
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
import { StatusRow } from "./settings-status";
import type { SystemStatus } from "./system-status";
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

// Settings → System, for every client: Status, which opens its page
// (settings-status.tsx), the version the home runs, the last restore from a
// backup, and updates: the versions the host can update to, a confirmed
// Update, the update's progress as the manager reports it and how it ended.
// The core restarts during an update; meanwhile the connection veil covers
// the page, and the progress carries on when the core is back.

const day = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "long",
});
const dayAndTime = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

export function SystemSettings(props: {
  core: CoreStatus;
  onUpdating: (updating: boolean) => void;
  // The host's status, which Home asks for now and then.
  status: SystemStatus | undefined;
  statusFailed: boolean;
  onOpenStatus: () => void;
}) {
  const { core } = props;
  const version =
    core.state === "online" || core.state === "updating"
      ? core.version
      : undefined;
  return (
    <>
      <StatusRow
        status={props.status}
        failed={props.statusFailed}
        onOpen={props.onOpenStatus}
      />
      <RestoreNotice online={core.state === "online"} />
      <Updates core={core} version={version} onUpdating={props.onUpdating} />
    </>
  );
}

// After a restore from a backup every device was signed out; the first to
// look is told what that means.
function RestoreNotice(props: { online: boolean }) {
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
  const date = restore.backupAt && day.format(new Date(restore.backupAt));
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

function Updates(props: {
  core: CoreStatus;
  // The version the core's health check reports, while it answers.
  version?: string;
  onUpdating: (updating: boolean) => void;
}) {
  const { core, onUpdating } = props;
  const [status, setStatus] = useState<UpdateStatus>();
  const [versions, setVersions] = useState<AvailableVersion[]>();
  const [selected, setSelected] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [starting, setStarting] = useState(false);
  const [problem, setProblem] = useState<string>();
  // The last answer was that the core or the manager is restarting.
  const [isWaiting, setIsWaiting] = useState(false);
  // An update this screen has seen running, whose ending it shows in full.
  const [followed, setFollowed] = useState<string>();
  const statusRevision = useRef(0);

  const update = status?.update ?? null;
  const running = !!update && update.step !== "done";
  const online = core.state === "online";
  const coreVersion = props.version ?? status?.version;

  useEffect(() => onUpdating(running), [running, onUpdating]);
  useEffect(() => () => onUpdating(false), [onUpdating]);

  // The update's status, often while one runs. While the core is away the
  // veil covers this page; it asks again as soon as the core is back.
  useEffect(() => {
    if (!online) return;
    let isStopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      let next = 30_000;
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

  // What the host can update to, again once an update has ended.
  const ended = update?.step === "done" ? update.id : undefined;
  useEffect(() => {
    if (!online) return;
    let isCurrent = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const answer = await systemUpdate.versions();
        if (!isCurrent) return;
        setVersions(answer.versions);
        setProblem(undefined);
      } catch (error) {
        if (!isCurrent) return;
        setProblem(problemText(error));
        if (isAway(error)) timer = setTimeout(load, 2_000);
      }
    };
    void load();
    return () => {
      isCurrent = false;
      clearTimeout(timer);
    };
  }, [online, ended]);

  // The newest build, when it is newer than the one the host runs and is not
  // the one that just failed, until someone chooses.
  const choices = versions ?? [];
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

  const start = async () => {
    if (!choice) return;
    setStarting(true);
    setProblem(undefined);
    try {
      const { update: started } = await systemUpdate.start(choice);
      statusRevision.current += 1;
      setStatus((current) => current && { ...current, update: started });
      setFollowed(started.id);
      setSelected(undefined);
    } catch (error) {
      setProblem(problemText(error));
    } finally {
      setStarting(false);
      setConfirming(false);
    }
  };

  if (!status) {
    return (
      <>
        <Row title="Version" detail={coreVersion ?? "Not known right now"} />
        {isWaiting && (
          <p className="m-0 text-[13px] text-white/65">
            Waiting for {productName} to answer…
          </p>
        )}
      </>
    );
  }

  // The core that answers runs the new version, and the manager is away:
  // it is replacing itself, the last step.
  const step: UpdateStep =
    running && isWaiting && coreVersion === update.version
      ? "finish"
      : (update?.step ?? "done");

  return (
    <div className="flex flex-col gap-4">
      <Row
        title="Version"
        detail={`${coreVersion ?? status.version} · ${channelNames[status.channel]}`}
      />
      {update && (running || update.id === followed) ? (
        <Progress update={update} step={step} />
      ) : (
        update && <LastUpdate update={update} />
      )}
      {!running && (
        <>
          {status.channel === "dev" ? (
            <VersionPicker
              versions={choices}
              running={coreVersion}
              selected={choice}
              onSelect={setSelected}
            />
          ) : (
            <p className="m-0 text-sm">
              Updates to the newest {status.channel} release.
            </p>
          )}
          <Button
            className="self-start"
            disabled={!choice || (isDev && choice === coreVersion) || starting}
            onClick={() => setConfirming(true)}
          >
            {status.channel === "dev" && choice
              ? `Update to ${choice}`
              : "Update"}
          </Button>
        </>
      )}
      {problem && (
        <p role="alert" className="m-0 text-[13px] text-(--danger)">
          {problem}
        </p>
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {status.channel === "dev"
                ? `Update to ${choice}?`
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
            <Button disabled={starting} onClick={() => void start()}>
              Update
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
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
        props.state === "later" && "text-white/65",
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
        <p className="m-0 text-[13px] break-words text-white/65">
          Reason: {update.error}
        </p>
      )}
    </div>
  );
}

// The last update, ended before this screen opened.
function LastUpdate(props: { update: UpdateInfo }) {
  const { update } = props;
  const { title } = outcomeText(update);
  const when = update.finishedAt ?? update.startedAt;
  const failed =
    update.outcome === "rolled-back" || update.outcome === "failed";
  return (
    <div className="flex flex-col gap-px leading-tight">
      <span className="text-sm font-medium">Last update</span>
      <span className="text-[13px] font-medium text-white/65">
        {title} · {dayAndTime.format(new Date(when))}
      </span>
      {failed && update.error && (
        <span className="text-[13px] break-words text-white/65">
          Reason: {update.error}
        </span>
      )}
    </div>
  );
}

// A dev host's builds, newest first; the one it runs cannot be chosen.
function VersionPicker(props: {
  versions: AvailableVersion[];
  running?: string;
  selected?: string;
  onSelect: (version: string) => void;
}) {
  if (props.versions.length === 0) {
    return (
      <p className="m-0 text-sm">
        No builds yet. Publish one to the dev registry first.
      </p>
    );
  }
  return (
    <fieldset className="m-0 flex flex-col gap-1 border-0 p-0">
      <legend className="sr-only">Version to update to</legend>
      {props.versions.map(({ version, builtAt }) => {
        const isRunning = version === props.running;
        const detail = [
          builtAt && `Built ${dayAndTime.format(new Date(builtAt))}`,
          isRunning && "Running",
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <label
            key={version}
            className={cn(
              "flex cursor-pointer items-center justify-between gap-3 rounded-md px-3 py-2 has-focus-visible:ring-3 has-focus-visible:ring-ring/50 has-checked:bg-white has-checked:text-(--carbon)",
              isRunning && "cursor-default text-white/65",
            )}
          >
            <input
              type="radio"
              name="version"
              value={version}
              checked={props.selected === version}
              disabled={isRunning}
              onChange={() => props.onSelect(version)}
              className="sr-only"
            />
            <span className="truncate text-sm font-medium">{version}</span>
            <span className="shrink-0 text-[13px] opacity-65">{detail}</span>
          </label>
        );
      })}
    </fieldset>
  );
}

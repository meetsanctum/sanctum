import type {
  AppFailure,
  AppGoBack,
  AppInfo,
  AppRunning,
  StaticManifest,
} from "@meetsanctum/app-sdk";
import { cn } from "cn";
import {
  Cpu,
  Database,
  Gauge,
  RotateCw,
  Undo2,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { canGoBack, dayWords } from "./app-go-back";
import { failureWords, lowerFirst } from "./app-state";
import { clockTime } from "./attention";
import { Section } from "./components";
import { coreJson } from "./core-fetch";
import { formatBytes } from "./system-status";

// How an app in its own container is running, near the end of its settings.
// It's for when something is wrong: its head and notice already say its
// state. Figures come with their words, never a bar alone, and a dash stands
// for one the home can't give.

const refreshMs = 5_000;
// In whole ones, as its limit is, so a figure that moves a little stays put.
const mebibyte = 1024 * 1024;
const noFigure = "—";

function useRunning(app: AppInfo) {
  const [running, setRunning] = useState<AppRunning | null>(null);
  const path = `/api/apps/${encodeURIComponent(app.id)}/running`;
  // Asked again at once as its state changes.
  useEffect(() => {
    let isCurrent = true;
    let isLoading = false;
    const controller = new AbortController();
    const load = async () => {
      if (isLoading) return;
      isLoading = true;
      try {
        const next = await coreJson<{ running: AppRunning | null }>(path, {
          signal: controller.signal,
        });
        if (isCurrent) setRunning(next.running);
      } catch {
        // Asked again in a moment.
      } finally {
        isLoading = false;
      }
    };
    void load();
    const timer = setInterval(() => void load(), refreshMs);
    return () => {
      isCurrent = false;
      clearInterval(timer);
      controller.abort();
    };
  }, [path, app.state]);
  return running;
}

/** "Under 1%", "12%": a percentage of one core. */
export function processorWords(share: number | null) {
  if (share === null) return noFigure;
  return share < 1 ? "Under 1%" : `${Math.round(share)}%`;
}

function lastRestartWords(last: { at: string; failure: AppFailure }) {
  const isToday =
    new Date(last.at).toDateString() === new Date().toDateString();
  const when = isToday
    ? `at ${clockTime(last.at)}`
    : `on ${dayWords(last.at)} at ${clockTime(last.at)}`;
  return `Last ${when}: ${lowerFirst(failureWords[last.failure])}`;
}

/** What the home remembers: failures don't outlive Sanctum's own restart. */
export function restartsWords(
  name: string,
  restarts: AppRunning["restarts"] | undefined,
) {
  return {
    figure: restarts?.recent
      ? `${restarts.recent} in 10 minutes`
      : "None lately",
    line: restarts?.last
      ? lastRestartWords(restarts.last)
      : `Only ${name} restarts, never the rest of your home`,
  };
}

function RunningRow(props: {
  icon: LucideIcon;
  title: string;
  line: string;
  figure?: string;
  problem?: boolean;
  children?: ReactNode;
}) {
  const { icon: Icon } = props;
  return (
    <li className="flex min-w-0 items-center gap-3">
      <span
        aria-hidden="true"
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/8"
      >
        <Icon className="size-4" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
        <span className="text-sm font-medium">{props.title}</span>
        <span
          className={cn(
            "text-[13px] leading-[18px] font-medium text-muted-foreground",
            props.problem && "text-destructive",
          )}
        >
          {props.line}
        </span>
        {props.children}
      </span>
      {props.figure && (
        <span className="shrink-0 text-sm font-medium tabular-nums">
          {props.figure}
        </span>
      )}
    </li>
  );
}

export function AppRunningSection(props: {
  app: AppInfo;
  manifest: StaticManifest;
  lastUpdate: AppGoBack | null;
}) {
  const { app, manifest, lastUpdate } = props;
  const running = useRunning(app);
  const limitMb = manifest.runtime.memory;
  const memory = running?.memoryBytes ?? null;
  const share = memory === null ? 0 : memory / (limitMb * mebibyte);
  const restarts = restartsWords(app.name, running?.restarts);
  return (
    <Section id="app-running" title="How it's running">
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        <RunningRow
          icon={Gauge}
          title="Memory"
          line={`Up to ${limitMb} MB. It restarts if it needs more.`}
          figure={
            memory === null ? noFigure : `${Math.round(memory / mebibyte)} MB`
          }
        >
          <span
            aria-hidden="true"
            data-testid="memory-bar"
            className="mt-2 block h-2 max-w-80 overflow-hidden rounded-xs bg-foreground/8"
          >
            <span
              className="block h-full bg-foreground/60"
              style={{ width: `${Math.min(share, 1) * 100}%` }}
            />
          </span>
        </RunningRow>
        <RunningRow
          icon={Cpu}
          title="Processor"
          line="Up to half of one core"
          figure={processorWords(running?.processor ?? null)}
        />
        <RunningRow
          icon={RotateCw}
          title="Restarts"
          line={restarts.line}
          figure={restarts.figure}
          problem={app.state === "failed"}
        />
        <RunningRow
          icon={Database}
          title="Its data"
          line={`Its own space, up to ${manifest.runtime.data} MB`}
          figure={
            running?.dataBytes == null
              ? noFigure
              : formatBytes(running.dataBytes)
          }
        />
        {lastUpdate && canGoBack(app) && (
          <RunningRow
            icon={Undo2}
            title="Its last update"
            line={`From ${lastUpdate.version} on ${dayWords(lastUpdate.since)}. Its data from before then is kept until its next update.`}
          />
        )}
      </ul>
    </Section>
  );
}

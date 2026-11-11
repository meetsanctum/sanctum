import {
  permissionWords,
  type AppFailure,
  type AppInfo,
  type AppRunUpdate,
  type PermissionInfo,
} from "@meetsanctum/app-sdk";
import { Button } from "@meetsanctum/ui-sdk";
import {
  Hourglass,
  Info,
  Power,
  RotateCw,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { useState, type ReactNode } from "react";

import { productName } from "./brand";
import { coreJson } from "./core-fetch";

// An app that isn't running, said the same everywhere it shows: paused while
// a permission it needs is off; stopped until Sanctum restarts when it
// didn't stop cleanly; or, for one in its own container, on its way back or
// given up on. The core refuses its calls meanwhile, so its pages, tiles and
// cards stay in view, dimmed, and can't be pressed, and each says why rather
// than fail without a reason. Going down doesn't show for its first 30 s,
// since most restarts end sooner and the core makes calls wait for them; its
// settings say so at once, since that's where people go to look.

/**
 * Whether Home and its pages go on as they were: it runs, it went down moments
 * ago, or it's on its way up for the first time.
 */
export function looksRunning(app: AppInfo) {
  switch (app.state) {
    case "running":
      return true;
    case "starting":
      return (
        app.run?.quiet === true ||
        (app.run?.isFirstStart === true &&
          app.run.update?.stage !== "updating" &&
          app.run.update?.stage !== "goingBack")
      );
    case "waiting":
    case "restarting":
      return app.run?.quiet === true;
    default:
      return false;
  }
}

/** Whether someone has to do something for it to run again. */
export const isGivenUp = (app: AppInfo) =>
  app.state === "failed" || app.state === "stopped";

export const failureWords: Record<AppFailure, string> = {
  crashed: "It stopped after an error in its code",
  out_of_memory: "It ran out of memory",
  hung: "It stopped answering",
  failed_start: "It didn't start",
};

/** What stopped it last. */
export const whyItStopped = (app: AppInfo) =>
  failureWords[app.run?.lastFailure ?? "crashed"];

/** "Waiting for Zigbee2MQTT", as it says, or for Sanctum itself. */
export const waitingWords = (app: AppInfo) =>
  app.run?.waitingFor ?? `Waiting for ${productName}`;

export const lowerFirst = (text: string) =>
  `${text.charAt(0).toLowerCase()}${text.slice(1)}`;

const ordinals = ["", "", "second", "third", "fourth"];

/** "Restarting · third time in 10 minutes", once it's more than the first. */
export function restartingWords(app: AppInfo) {
  const time = ordinals[app.run?.failures ?? 0];
  return time ? `Restarting · ${time} time in 10 minutes` : "Restarting";
}

/** Why it stopped for good: how often, and what stopped it the last time. */
export const givenUpWords = "Stopped after 5 failures in 10 minutes";

/** "Version 0.4.0 didn't start, so it's back on 0.3.0." */
export function wentBackWords(
  app: AppInfo,
  update: Extract<AppRunUpdate, { stage: "wentBack" }>,
) {
  if (update.chosen) {
    return `Went back to ${app.version} from ${update.from}`;
  }
  return `Version ${update.from} ${update.triesAgain ? "wasn't ready" : "didn't start"}, so it's back on ${app.version}`;
}

/** The first permission the app needs that is off, which pauses it. */
export function pausedFor(app: AppInfo): PermissionInfo | undefined {
  return app.requests.find(
    (request) => request.needed && !app.permissions.includes(request.id),
  );
}

/** What the app's tiles and cards say while it isn't running; nothing while it runs. */
export function stateShort(app: AppInfo) {
  if (looksRunning(app)) return null;
  if (app.state === "off") return "Off";
  return app.state === "paused" ? "Paused" : "Not running";
}

/** Whether what it adds to the home shows: not while someone has turned it off. */
export const isShown = (app: AppInfo) => app.state !== "off";

// What it adds to the home, as turning it off changes it. A driver's devices come
// from what the caller knows of them; the rest is the app's own to say.
function whatItAdds(app: AppInfo, deviceCount: number) {
  const { widgets, roomSections } = app.provides;
  const cards = widgets.length;
  const devices = deviceCount === 1 ? "device" : `${deviceCount} devices`;
  return [
    ...(cards > 0
      ? [
          {
            goes:
              cards === 1
                ? "Its card leaves Home"
                : `Its ${cards} cards leave Home`,
            gone:
              cards === 1
                ? "Its card isn't on Home"
                : `Its ${cards} cards aren't on Home`,
          },
        ]
      : []),
    ...roomSections.map(({ title }) => ({
      goes: `Its ${title.toLowerCase()} leave every room`,
      gone: `Its ${title.toLowerCase()} aren't in any room`,
    })),
    ...(deviceCount > 0
      ? [
          {
            goes: `Its ${devices} ${deviceCount === 1 ? "goes" : "go"} offline, and remotes and automations can't use ${deviceCount === 1 ? "it" : "them"}`,
            gone: `Its ${devices} ${deviceCount === 1 ? "is" : "are"} offline`,
          },
        ]
      : []),
  ];
}

const joined = (parts: readonly string[]) =>
  parts.map((part, at) => (at === 0 ? part : lowerFirst(part))).join(", and ");

/** What turning it off asks about: what goes, naming it, and that its data stays. */
export function turningOffWords(app: AppInfo, deviceCount: number) {
  const parts = whatItAdds(app, deviceCount).map(({ goes }) => goes);
  return `${joined(parts.length > 0 ? parts : ["It stops running"])} until you turn it back on. Its data stays.`;
}

/** What its notice says once it's off. */
function offWords(app: AppInfo, deviceCount: number) {
  const parts = whatItAdds(app, deviceCount).map(({ gone }) => gone);
  // Only a container of its own gives its memory back.
  const said = joined(parts.length > 0 ? parts : ["It doesn't run"]);
  return `${said}${app.run ? ", and it uses no memory" : ""}. Its data stays, so turning it on brings everything back.`;
}

/** "it needs “Control your lights”", for a paused app. */
export function needsWords(app: AppInfo) {
  const paused = pausedFor(app);
  return paused
    ? `it needs “${permissionWords(paused.id).title}”`
    : "it needs a permission that's off";
}

/** Turns an app back on, which needs no asking: it only brings things back. */
export function TurnOnButton(props: { app: AppInfo }) {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const turnOn = () => {
    setState("busy");
    coreJson<AppInfo>(`/api/apps/${encodeURIComponent(props.app.id)}/off`, {
      method: "POST",
      json: { off: false },
    }).then(
      () => setState("idle"),
      () => setState("failed"),
    );
  };
  return (
    <Button
      disabled={state === "busy"}
      aria-label={
        state === "failed"
          ? `Try again to turn on ${props.app.name}`
          : `Turn on ${props.app.name}`
      }
      onClick={turnOn}
    >
      {state === "failed" ? "Try again" : "Turn on"}
    </Button>
  );
}

/** Starts again an app its supervisor gave up on, saying so if it can't. */
export function RestartButton(props: {
  app: AppInfo;
  variant?: "default" | "outline";
  size?: "sm";
}) {
  const [state, setState] = useState<"idle" | "busy" | "failed">("idle");
  const restart = () => {
    setState("busy");
    coreJson<AppInfo>(`/api/apps/${encodeURIComponent(props.app.id)}/restart`, {
      method: "POST",
      json: {},
    }).then(
      // What it says next arrives as it changes, as any app's does.
      () => setState("idle"),
      () => setState("failed"),
    );
  };
  return (
    <Button
      variant={props.variant ?? "default"}
      size={props.size}
      disabled={state === "busy"}
      aria-label={
        state === "failed"
          ? `Try again to restart ${props.app.name}`
          : `Restart ${props.app.name}`
      }
      onClick={restart}
    >
      {state === "failed" ? "Try again" : "Restart"}
    </Button>
  );
}

// What its notice says, and whether it's something wrong. Nothing for an app
// that's running, or still on its way up for the first time.
function noticeOf(
  app: AppInfo,
  permissionsAre: "below" | "settings",
  deviceCount: number,
) {
  const { name } = app;
  const update = app.run?.update;
  const canShowProgress =
    app.state === "starting" ||
    app.state === "waiting" ||
    app.state === "restarting";
  if (update?.stage === "updating" && canShowProgress) {
    return {
      Icon: RotateCw,
      title: `${name} is updating to ${update.to}`,
      line: "It starts by itself once it has.",
    };
  }
  // Someone just asked, and it hasn't stopped yet.
  if (
    update?.stage === "goingBack" &&
    (canShowProgress || app.state === "running")
  ) {
    return {
      Icon: RotateCw,
      title: `${name} is going back to ${update.to}`,
      line: "It starts by itself once its data is back.",
    };
  }
  if (update?.stage === "wentBack" && app.state === "running") {
    return {
      Icon: Info,
      title: wentBackWords(app, update),
      line: update.chosen
        ? `It stays on ${app.version} until a newer version arrives.`
        : update.triesAgain
          ? "It tries again later."
          : "It isn't tried again until a newer version arrives.",
    };
  }
  switch (app.state) {
    case "off":
      return {
        Icon: Power,
        title: `${name} is off`,
        line: offWords(app, deviceCount),
      };
    case "stopped":
      return {
        Icon: TriangleAlert,
        title: `${name} isn't running`,
        line: `It didn't stop cleanly, so it starts again only when ${productName} restarts.`,
      };
    case "failed":
      return {
        Icon: TriangleAlert,
        title: `${name} isn't running`,
        line: `It stopped after 5 failures in 10 minutes. The last time, ${lowerFirst(whyItStopped(app))}.`,
      };
    case "paused": {
      const needs = needsWords(app);
      return {
        Icon: Info,
        title: `${name} is paused`,
        line: `${needs.charAt(0).toUpperCase()}${needs.slice(1)} to work. Turn it back on ${
          permissionsAre === "below" ? "below" : "in its settings"
        } to start it again.`,
      };
    }
    case "waiting": {
      const words = waitingWords(app);
      return {
        Icon: Hourglass,
        title: /^waiting /i.test(words)
          ? `${name} is ${lowerFirst(words)}`
          : `${name}: ${words}`,
        line: "It starts by itself once it can.",
      };
    }
    case "restarting":
    case "starting":
      return app.run?.isFirstStart === true
        ? null
        : {
            Icon: RotateCw,
            title: `${name} is ${app.state === "restarting" || app.run?.lastFailure ? "restarting" : "starting"}`,
            line: app.run?.lastFailure
              ? `${whyItStopped(app)}, and it starts again by itself.`
              : "It starts again by itself.",
          };
    default:
      return null;
  }
}

/**
 * What needs someone while the app isn't running, above its pages and on its
 * settings page, which says so at once: paused, with what it needs and where to
 * turn that back on; on its way back, saying why; or stopped, with what starts it
 * again.
 */
export function AppNotice(props: {
  app: AppInfo;
  /** "below" on its settings page, "settings" elsewhere. */
  permissionsAre: "below" | "settings";
  /** Opens its settings, where a page's way out isn't lost by it. */
  openSettings?: () => void;
  openStatus: () => void;
  /** How many devices it brings, where the caller knows. */
  deviceCount?: number;
}) {
  const { app, permissionsAre } = props;
  const onItsSettings = permissionsAre === "below";
  if (!onItsSettings && looksRunning(app)) return null;
  const notice = noticeOf(app, permissionsAre, props.deviceCount ?? 0);
  if (!notice) return null;
  const { Icon, title, line } = notice;
  let action: ReactNode = null;
  if (app.state === "off") {
    action = <TurnOnButton app={app} />;
  } else if (app.state === "failed") {
    action = <RestartButton app={app} />;
  } else if (app.state === "stopped") {
    action = (
      <Button variant="outline" onClick={props.openStatus}>
        Open Status
      </Button>
    );
  } else if (props.openSettings) {
    action = (
      <Button variant="outline" onClick={props.openSettings}>
        Open settings
      </Button>
    );
  }
  return (
    <NoticeCard
      Icon={Icon}
      isWrong={isGivenUp(app)}
      title={title}
      line={line}
      action={action}
    />
  );
}

/** The card a notice stands on. */
export function NoticeCard(props: {
  Icon: LucideIcon;
  isWrong?: boolean;
  title: string;
  line: string;
  action?: ReactNode;
}) {
  const { Icon } = props;
  return (
    <div
      role="status"
      className="flex shrink-0 flex-wrap items-center gap-3 rounded-lg bg-card px-4 py-3.5 text-card-foreground"
    >
      <Icon
        aria-hidden="true"
        className={
          props.isWrong ? "size-5 shrink-0 text-destructive" : "size-5 shrink-0"
        }
      />
      <span className="flex min-w-[min(220px,100%)] flex-1 flex-col gap-px leading-tight">
        <span className="text-sm font-medium">{props.title}</span>
        <span className="text-[13px] leading-[18px] font-medium text-muted-foreground">
          {props.line}
        </span>
      </span>
      {props.action}
    </div>
  );
}

/**
 * Around one of the app's pages: while the app isn't running, the page
 * stays in view, dimmed, and nothing on it can be pressed, since the core
 * would refuse it all. It is always there, so the page keeps what it holds
 * as the app pauses and starts again.
 */
export function WhileNotRunning(props: {
  app: AppInfo;
  className: string;
  children: ReactNode;
}) {
  const running = looksRunning(props.app);
  return (
    <div
      inert={!running}
      className={running ? props.className : `${props.className} opacity-50`}
    >
      {props.children}
    </div>
  );
}

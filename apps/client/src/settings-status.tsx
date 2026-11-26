import type { AppInfo, TemperatureUnit } from "@meetsanctum/app-sdk";
import { Button, useHomeClock, useTemperatureUnit } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Clock,
  Gauge,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import { useEffect, type ReactNode } from "react";

import { productName } from "./brand";
import { Section, SettingsPageBar } from "./components";
import {
  connectionText,
  fineDetail,
  fineText,
  lastAtText,
  modelText,
  notSetUpWords,
  osText,
  problemFix,
  problemTitle,
  processorText,
  runningFor,
  useSystemStatus,
  type HostInfo,
  type HostProblem,
  type SystemStatus,
} from "./system-status";
import type { CoreStatus } from "./core-status";
import { Fact, Facts } from "./settings-status-facts";
import { ConnectedSection } from "./settings-status-connected";
import { MemorySection, StorageSection } from "./settings-status-parts";
import { LastDaySection } from "./settings-status-day";
import { PowerButtons, type PowerAction } from "./settings-status-power";
import {
  FreeUpButton,
  hasSpaceToFree,
  useSpace,
  type Space,
} from "./settings-status-space";
import {
  RestoreNotice,
  UpdatesSection,
  useSystemUpdate,
} from "./settings-updates";

// Settings → System: what's going on with the machine Sanctum runs on and
// the version it runs, the same on every client. Its row on Settings' first
// page says a green check and "Everything's running" while nothing needs
// anyone, otherwise the first problem in red; the page leads with the same
// verdict, each problem with what to do, and a restore's notice while there
// is one, then Sanctum's model, processor, power supply and system with
// Restart and Shut down, its updates (settings-updates.tsx), the storage
// with Free up space and the memory with what fills them
// (settings-status-parts.tsx), the last 24 hours of the processor, its
// temperature and the memory, each headed by what it reads now
// (settings-status-day.tsx), the network and the clients connected now. It
// asks every 5 seconds while open, and figures change in place.

const appNamer = (apps: readonly AppInfo[]) => (id: string) =>
  apps.find((app) => app.id === id)?.name ?? id;

const plainRound = (Icon: LucideIcon) => (
  <span
    aria-hidden="true"
    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-foreground/8"
  >
    <Icon className="size-4" />
  </span>
);

// The line of System's row in Settings and of Sanctum in Needs attention: the first problem, or every one, in red after
// a sign; or a green check and "Everything's running" with what's free and
// how warm it is.
export function SummaryLine(props: {
  status: SystemStatus | undefined;
  failed: boolean;
  unit: TemperatureUnit;
  // Only the first problem, and how many more.
  first?: boolean;
}) {
  const { status, unit } = props;
  let content: ReactNode;
  if (props.failed || !status) {
    content = (
      <span className="truncate">
        {props.failed ? "Can't check right now" : "Checking…"}
      </span>
    );
  } else if (!status.host) {
    content = <span className="truncate">Can't check right now</span>;
  } else if (status.problems.length > 0) {
    const titles = status.problems.map((each) => problemTitle(each, unit));
    const more = status.problems.length - 1;
    content = (
      <>
        <CircleAlert
          aria-hidden="true"
          className="size-3.5 shrink-0 text-destructive"
        />
        <span className="truncate">
          <span className="text-destructive">
            {props.first ? titles[0] : titles.join(" · ")}
          </span>
          {props.first && more > 0 && ` · and ${more} more`}
        </span>
      </>
    );
  } else {
    const detail = fineDetail(status.host, unit);
    content = (
      <>
        <Check
          aria-hidden="true"
          className="size-3.5 shrink-0 text-green"
          strokeWidth={2.5}
        />
        <span className="truncate">
          <span className="text-green">Everything's running</span>
          {detail && ` · ${detail}`}
        </span>
      </>
    );
  }
  return (
    <span className="flex min-w-0 items-center gap-1 text-[13px] font-medium text-muted-foreground">
      {content}
    </span>
  );
}

// What a screen reader hears of the summary, as SummaryLine shows it.
export function summarySpoken(
  status: SystemStatus | undefined,
  unit: TemperatureUnit,
  failed = false,
) {
  if (!failed && !status) return "checking";
  if (failed || !status?.host) return "can't check right now";
  if (status.problems.length === 0) return "everything's running";
  return status.problems.map((each) => problemTitle(each, unit)).join(", ");
}

/** Sanctum in Needs attention, while anything about it needs someone: its first problem, opening System. */
export function SanctumAttentionRow(props: {
  status: SystemStatus;
  onOpen: () => void;
}) {
  const unit = useTemperatureUnit() ?? "celsius";
  return (
    <Button
      variant="row"
      size="row"
      type="button"
      onClick={props.onOpen}
      aria-label={`${productName}: ${summarySpoken(props.status, unit)}. Opens System`}
      className="-mx-2.5 w-[calc(100%+20px)]"
    >
      {plainRound(Gauge)}
      <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
        <span className="truncate text-sm font-medium">{productName}</span>
        <SummaryLine status={props.status} failed={false} unit={unit} first />
      </span>
      <ChevronRight
        aria-hidden="true"
        className="ms-auto size-4 shrink-0 text-muted-foreground"
      />
    </Button>
  );
}

// A verdict's row: a glyph without a round, its words and what to do.
function VerdictRow(props: {
  icon: ReactNode;
  title: string;
  detail: string;
  tone?: "fine" | "problem";
  // Its fix, where one can be pressed here.
  action?: ReactNode;
}) {
  return (
    <li className="flex flex-wrap items-start gap-x-3 gap-y-2.5">
      <span className="flex size-6 shrink-0 items-center justify-center">
        {props.icon}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
        <span
          className={cn(
            "text-sm leading-6 font-medium",
            props.tone === "fine" && "text-green",
            props.tone === "problem" && "text-destructive",
          )}
        >
          {props.title}
        </span>
        <span className="text-[13px] font-medium text-muted-foreground">
          {props.detail}
        </span>
      </span>
      {props.action}
    </li>
  );
}

function Verdict(props: {
  status: SystemStatus | undefined;
  unit: TemperatureUnit;
  apps: readonly AppInfo[];
  // Storage almost full carries Free up space as its fix.
  space?: Space;
}) {
  const clock = useHomeClock();
  const { host, problems = [], notSetUp = [] } = props.status ?? {};
  // A service the home never set up is no problem: it is said plainly,
  // under whatever the verdict is.
  const waiting = notSetUp.map((each) => {
    const { title, detail } = notSetUpWords(each);
    return (
      <VerdictRow
        key={`not set up ${each.service}`}
        icon={
          <Unplug aria-hidden="true" className="size-5 text-muted-foreground" />
        }
        title={title}
        detail={detail}
      />
    );
  });
  let rows: ReactNode;
  if (!host) {
    rows = (
      <VerdictRow
        icon={
          <Clock aria-hidden="true" className="size-5 text-muted-foreground" />
        }
        title="Can't check right now"
        detail={
          props.status
            ? `${productName}'s updater isn't answering. It's usually back within a minute, and this fills in by itself`
            : "Couldn't read the status. It checks again by itself"
        }
      />
    );
  } else if (problems.length === 0) {
    rows = (
      <VerdictRow
        icon={
          <Check
            aria-hidden="true"
            className="size-5 text-green"
            strokeWidth={2.5}
          />
        }
        title="Everything's running"
        detail={fineText(host)}
        tone="fine"
      />
    );
  } else {
    const appName = appNamer(props.apps);
    rows = problems.map((problem) => (
      <VerdictRow
        key={JSON.stringify(problem)}
        icon={
          <CircleAlert aria-hidden="true" className="size-5 text-destructive" />
        }
        title={problemTitle(problem, props.unit)}
        detail={problemFix(clock, problem, appName)}
        tone="problem"
        action={
          problem.kind === "storage" &&
          props.space &&
          hasSpaceToFree(props.space) ? (
            <FreeUpButton space={props.space} />
          ) : undefined
        }
      />
    ));
  }
  return (
    <ul role="status" className="m-0 flex list-none flex-col gap-3 p-0">
      {rows}
      {host && waiting}
    </ul>
  );
}

// The power supply, as the verdict judges it: too weak now, or lately.
function PowerFact(props: {
  power: NonNullable<HostInfo["power"]>;
  problems: HostProblem[];
}) {
  const { power } = props;
  const clock = useHomeClock();
  const problem = props.problems.find((each) => each.kind === "power");
  return (
    <Fact label="Power supply" problem={power.low || !!problem}>
      {power.low
        ? "Too weak right now"
        : problem?.kind === "power"
          ? `Too weak · last at ${lastAtText(clock, problem.lastLowAt)}`
          : "Enough power"}
    </Fact>
  );
}

function NetworkSection(props: { host: HostInfo }) {
  const { network, hostname, clock } = props.host;
  return (
    <Section id="status-network" title="Network">
      <Facts>
        {network && <Fact label="Connection">{connectionText(network)}</Fact>}
        {hostname && (
          <Fact label="Name on the network">{`${hostname}.local`}</Fact>
        )}
        {network?.address && <Fact label="IP address">{network.address}</Fact>}
        {clock !== null && (
          <Fact label="Clock" problem={!clock}>
            {clock ? "Synchronised" : "Not synchronised"}
          </Fact>
        )}
      </Facts>
    </Section>
  );
}

// The rows' shapes, at once, while the first answer is on its way: Sanctum's
// above Updates, and Storage's under it.
const shape = "block h-3 rounded-xs bg-foreground/8";

function SanctumLoading() {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      <span className="flex items-center gap-3">
        <span className="size-6 shrink-0 rounded-full bg-foreground/8" />
        <span className={cn(shape, "w-2/5")} />
      </span>
      {["w-1/3", "w-1/4", "w-2/5", "w-1/5", "w-1/2"].map((width) => (
        <span key={width} className={cn(shape, width)} />
      ))}
    </div>
  );
}

function StorageLoading() {
  return (
    <Section id="status-storage" title="Storage">
      <div aria-busy="true" className="flex flex-col gap-3">
        <span className="block h-4 rounded-xs bg-foreground/8" />
        <span className={cn(shape, "w-1/3")} />
        <span className={cn(shape, "w-1/4")} />
      </div>
    </Section>
  );
}

/** The System page: the verdict, then Sanctum with Restart and Shut down, its updates, its storage with Free up space, memory, the last 24 hours, network and the clients connected now. */
export function SystemPage(props: {
  apps: readonly AppInfo[];
  core: CoreStatus;
  // Whether an update is running, for the connection veil's words.
  onUpdating: (updating: boolean) => void;
  onDone: () => void;
  // The page under it in Settings, which Back returns to: without one it
  // was opened from elsewhere, and Done closes it.
  backTo?: string;
  onPowerAccepted?: (action: PowerAction) => void;
}) {
  const { core, onUpdating } = props;
  const online = core.state === "online";
  const { status, failed } = useSystemStatus({ enabled: true, everyMs: 5_000 });
  const update = useSystemUpdate(online);
  const space = useSpace(update.running, update.ended);
  const unit = useTemperatureUnit() ?? "celsius";
  const host = failed ? null : status?.host;
  const isLoading = !status && !failed;

  useEffect(() => onUpdating(update.running), [onUpdating, update.running]);
  useEffect(() => () => onUpdating(false), [onUpdating]);

  return (
    <>
      <SettingsPageBar
        title="System"
        backTo={props.backTo}
        onBack={props.onDone}
      />
      <Section id="status-sanctum" title={productName}>
        <RestoreNotice online={online} />
        {isLoading ? (
          <SanctumLoading />
        ) : (
          <>
            <Verdict
              status={failed ? undefined : status}
              unit={unit}
              apps={props.apps}
              space={space}
            />
            {host && (
              <Facts>
                {modelText(host) && (
                  <Fact label="Model">{modelText(host)}</Fact>
                )}
                <Fact label="Processor">{processorText(host.processor)}</Fact>
                {host.power && (
                  <PowerFact power={host.power} problems={status!.problems} />
                )}
                {osText(host) && (
                  <Fact label="Operating system">{osText(host)}</Fact>
                )}
                {host.uptimeSeconds != null && (
                  <Fact label="Running for">
                    {runningFor(host.uptimeSeconds)}
                  </Fact>
                )}
              </Facts>
            )}
            {host && (
              <PowerButtons
                updating={update.running}
                onPowerAccepted={props.onPowerAccepted}
              />
            )}
          </>
        )}
      </Section>
      <UpdatesSection
        core={core}
        system={update}
        freeing={space.state.at === "freeing"}
        cleanupRevision={space.cleanupRevision}
      />
      {isLoading ? (
        <StorageLoading />
      ) : (
        host && (
          <>
            <StorageSection
              host={host}
              problems={status!.problems}
              apps={props.apps}
              space={space}
            />
            <MemorySection
              host={host}
              problems={status!.problems}
              apps={props.apps}
            />
            <LastDaySection
              host={host}
              problems={status!.problems}
              unit={unit}
              checkedAt={status!.checkedAt}
            />
            <NetworkSection host={host} />
            <ConnectedSection />
          </>
        )
      )}
    </>
  );
}

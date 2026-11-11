import type { AppInfo, TemperatureUnit } from "@meetsanctum/app-sdk";
import { Button, PageBar, useTemperatureUnit } from "@meetsanctum/ui-sdk";
import { cn } from "cn";
import {
  Check,
  ChevronRight,
  CircleAlert,
  Clock,
  Gauge,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { productName } from "./brand";
import { Section } from "./components";
import {
  connectionText,
  fineDetail,
  fineText,
  lastAtText,
  modelText,
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
import { channelNames } from "./system-update";
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

// Settings → Status: what's going on with the machine Sanctum runs on, the
// same on every client. Its row comes first in System, a green check and
// "Everything's running" while nothing needs anyone, otherwise each problem
// in red; the page, a page of Settings with Done, leads with the same
// verdict, each problem with what to do, then Sanctum's model, processor,
// power supply, version and system with Restart and Shut down, the storage
// with Free up space and the memory with what fills them
// (settings-status-parts.tsx), the last 24 hours of the processor, its
// temperature and the memory, each headed by what it reads now
// (settings-status-day.tsx), the network and the clients connected now. It
// asks every 5 seconds while open, and figures change in place.

export const statusSettingsPage = "status";

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

// The line of System's row and of Sanctum in Needs attention: the first
// problem, or every one, in red after a sign; or a green check and
// "Everything's running" with what's free and how warm it is.
function SummaryLine(props: {
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
function summarySpoken(
  status: SystemStatus | undefined,
  unit: TemperatureUnit,
  failed = false,
) {
  if (!failed && !status) return "checking";
  if (failed || !status?.host) return "can't check right now";
  if (status.problems.length === 0) return "everything's running";
  return status.problems.map((each) => problemTitle(each, unit)).join(", ");
}

// A row that opens Status, as Maintenance's updates row opens its page.
function OpensStatus(props: {
  title: string;
  label: string;
  line: ReactNode;
  onOpen: () => void;
}) {
  return (
    <Button
      variant="row"
      size="row"
      type="button"
      onClick={props.onOpen}
      aria-label={props.label}
      className="-mx-2.5 w-[calc(100%+20px)]"
    >
      {plainRound(Gauge)}
      <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
        <span className="truncate text-sm font-medium">{props.title}</span>
        {props.line}
      </span>
      <ChevronRight
        aria-hidden="true"
        className="ms-auto size-4 shrink-0 text-muted-foreground"
      />
    </Button>
  );
}

/** System's first row: Status and how Sanctum is doing, opening the page. */
export function StatusRow(props: {
  status: SystemStatus | undefined;
  failed: boolean;
  onOpen: () => void;
}) {
  const unit = useTemperatureUnit() ?? "celsius";
  return (
    <OpensStatus
      title="Status"
      label={`Status: ${summarySpoken(props.status, unit, props.failed)}. Opens Status`}
      line={
        <SummaryLine status={props.status} failed={props.failed} unit={unit} />
      }
      onOpen={props.onOpen}
    />
  );
}

/** Sanctum in Needs attention, while anything about it needs someone: its first problem, opening Status. */
export function SanctumAttentionRow(props: {
  status: SystemStatus;
  onOpen: () => void;
}) {
  const unit = useTemperatureUnit() ?? "celsius";
  return (
    <OpensStatus
      title={productName}
      label={`${productName}: ${summarySpoken(props.status, unit)}. Opens Status`}
      line={
        <SummaryLine status={props.status} failed={false} unit={unit} first />
      }
      onOpen={props.onOpen}
    />
  );
}

function Fact(props: {
  label: string;
  children: ReactNode;
  problem?: boolean;
}) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
      <dt className="text-sm font-medium">{props.label}</dt>
      <dd
        className={cn(
          "m-0 flex min-w-0 items-center gap-1 text-end text-sm text-muted-foreground tabular-nums",
          props.problem && "text-destructive",
        )}
      >
        {props.problem && (
          <CircleAlert aria-hidden="true" className="size-3.5 shrink-0" />
        )}
        {props.children}
      </dd>
    </div>
  );
}

const Facts = (props: { children: ReactNode }) => (
  <dl className="m-0 flex flex-col gap-3">{props.children}</dl>
);

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
  const { host, problems = [] } = props.status ?? {};
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
            ? "Updates and services isn't answering. It's usually back within a minute, and this fills in by itself"
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
        detail={problemFix(problem, appName)}
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
    </ul>
  );
}

// The power supply, as the verdict judges it: too weak now, or lately.
function PowerFact(props: {
  power: NonNullable<HostInfo["power"]>;
  problems: HostProblem[];
}) {
  const { power } = props;
  const problem = props.problems.find((each) => each.kind === "power");
  return (
    <Fact label="Power supply" problem={power.low || !!problem}>
      {power.low
        ? "Too weak right now"
        : problem?.kind === "power"
          ? `Too weak · last at ${lastAtText(problem.lastLowAt)}`
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

// The rows' shapes, at once, while the first answer is on its way.
function Loading() {
  const shape = "block h-3 rounded-xs bg-foreground/8";
  return (
    <>
      <Section id="status-sanctum" title={productName}>
        <div aria-busy="true" className="flex flex-col gap-3">
          <span className="flex items-center gap-3">
            <span className="size-6 shrink-0 rounded-full bg-foreground/8" />
            <span className={cn(shape, "w-2/5")} />
          </span>
          {["w-1/3", "w-1/4", "w-2/5", "w-1/5", "w-1/2", "w-1/6"].map(
            (width) => (
              <span key={width} className={cn(shape, width)} />
            ),
          )}
        </div>
      </Section>
      <Section id="status-storage" title="Storage">
        <div aria-busy="true" className="flex flex-col gap-3">
          <span className="block h-4 rounded-xs bg-foreground/8" />
          <span className={cn(shape, "w-1/3")} />
          <span className={cn(shape, "w-1/4")} />
        </div>
      </Section>
    </>
  );
}

/** The Status page: the verdict, then Sanctum with Restart and Shut down, its storage with Free up space, memory, the last 24 hours, network and the clients connected now. */
export function StatusPage(props: {
  apps: readonly AppInfo[];
  onDone: () => void;
  onPowerAccepted?: (action: PowerAction) => void;
}) {
  const { status, failed } = useSystemStatus({ enabled: true, everyMs: 5_000 });
  const space = useSpace();
  const unit = useTemperatureUnit() ?? "celsius";
  const host = failed ? null : status?.host;
  return (
    <>
      <PageBar title="Status">
        <Button variant="outline" onClick={props.onDone}>
          Done
        </Button>
      </PageBar>
      {!status && !failed ? (
        <Loading />
      ) : (
        <>
          <Section id="status-sanctum" title={productName}>
            <Verdict
              status={failed ? undefined : status}
              unit={unit}
              apps={props.apps}
              space={space}
            />
            <Facts>
              {host && modelText(host) && (
                <Fact label="Model">{modelText(host)}</Fact>
              )}
              {host && (
                <Fact label="Processor">{processorText(host.processor)}</Fact>
              )}
              {host?.power && (
                <PowerFact power={host.power} problems={status!.problems} />
              )}
              {status && (
                <Fact label="Version">
                  {status.channel
                    ? `${status.version} · ${channelNames[status.channel]}`
                    : status.version}
                </Fact>
              )}
              {host && osText(host) && (
                <Fact label="Operating system">{osText(host)}</Fact>
              )}
              {host?.uptimeSeconds != null && (
                <Fact label="Running for">
                  {runningFor(host.uptimeSeconds)}
                </Fact>
              )}
            </Facts>
            {host && <PowerButtons onPowerAccepted={props.onPowerAccepted} />}
          </Section>
          {host && (
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
          )}
        </>
      )}
    </>
  );
}

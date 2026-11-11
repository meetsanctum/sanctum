import type { AppInfo } from "@meetsanctum/app-sdk";
import { cn } from "cn";

import { AppIcon } from "./app-icon";
import { productName } from "./brand";
import { Section } from "./components";
import { OldVersionsRow, type Space } from "./settings-status-space";
import {
  formatBytes,
  formatMemory,
  serviceName,
  systemName,
  type HostInfo,
  type HostProblem,
  type MemoryPart,
  type StoragePart,
} from "./system-status";

// Status' Storage and Memory: a bar of what fills each, 16 px with 2 px
// between its parts and the free space its track, then a row for each part
// with its swatch or its app's icon and its size. Storage ends with Free up
// space (settings-status-space.tsx).

// The app colours by their plain names, for each app's part of the bar.
const colourOf: Record<string, string> = {
  ember: "bg-orange",
  sun: "bg-yellow",
  ruby: "bg-red",
  leaf: "bg-green",
  sky: "bg-cyan",
  blossom: "bg-pink",
  iris: "bg-purple",
  graphite: "bg-gray",
};

// The services, as Status shows them.
const serviceLooks: Record<string, { colour: string; line: string }> = {
  zigbee2mqtt: {
    colour: "bg-gray",
    line: "Talks to your Zigbee devices, for the Zigbee app",
  },
  mosquitto: {
    colour: "bg-orange",
    line: `Carries messages between Zigbee and ${productName}`,
  },
};

// A service in the line of the app that uses it.
const serviceWords: Record<string, string> = {
  zigbee2mqtt: "Zigbee2MQTT",
  mosquitto: "messaging",
};

const systemColour = "bg-foreground/24";

// One part of the storage or memory, with its share of the bar.
type Part = {
  key: string;
  name: string;
  line?: string;
  bytes: number;
  colour: string;
  icon?: AppInfo["icon"];
};

function Bar(props: { parts: Part[]; total: number; label: string }) {
  return (
    <div
      role="img"
      aria-label={props.label}
      className="flex h-4 gap-0.5 overflow-hidden rounded-xs"
    >
      {props.parts.map((part) => (
        <span
          key={part.key}
          className={cn("h-full min-w-[3px] shrink-0", part.colour)}
          style={{ width: `${(part.bytes / props.total) * 100}%` }}
        />
      ))}
      <span className="h-full flex-1 bg-foreground/8" />
    </div>
  );
}

function PartRow(props: {
  part: Part;
  size: string;
  // A part outside the bar, as swap is.
  outside?: boolean;
  problem?: boolean;
}) {
  const { part } = props;
  return (
    <li className="flex items-center gap-3">
      <span className="flex size-6 shrink-0 items-center justify-center">
        {part.icon ? (
          <AppIcon icon={part.icon} className="size-6" />
        ) : (
          <span
            aria-hidden="true"
            className={cn(
              "size-4 rounded-xs",
              props.outside
                ? "border-[1.5px] border-dashed border-muted-foreground"
                : part.colour,
            )}
          />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-px leading-tight">
        <span
          className={cn(
            "truncate text-sm font-medium",
            props.problem && "text-destructive",
          )}
        >
          {part.name}
        </span>
        {part.line && (
          <span className="truncate text-[13px] font-medium text-muted-foreground">
            {part.line}
          </span>
        )}
      </span>
      <span className="shrink-0 text-sm text-muted-foreground tabular-nums">
        {props.size}
      </span>
    </li>
  );
}

const bySize = (a: { bytes: number }, b: { bytes: number }) =>
  b.bytes - a.bytes;

function storageParts(
  parts: StoragePart[],
  host: HostInfo,
  apps: readonly AppInfo[],
): Part[] {
  const named: Part[] = [];
  const own: Part[] = [];
  let system: Part | undefined;
  for (const part of parts) {
    switch (part.kind) {
      case "devBuilds":
        named.push({
          key: "devBuilds",
          name: "Dev builds",
          line: "Builds to update to, on the dev channel",
          bytes: part.bytes,
          colour: "bg-pink",
        });
        break;
      case "software":
        named.push({
          key: "software",
          name: "Software",
          line: "This version and the one before, to go back to",
          bytes: part.bytes,
          colour: "bg-purple",
        });
        break;
      case "home":
        named.push({
          key: "home",
          name: "Home's data",
          line: `Backups ${formatBytes(part.backups)} · devices, history and activity ${formatBytes(part.data)}`,
          bytes: part.bytes,
          colour: "bg-green",
        });
        break;
      case "app": {
        const app = apps.find((each) => each.id === part.app);
        own.push({
          key: `app:${part.app}`,
          name: app?.name ?? part.app,
          bytes: part.bytes,
          colour: colourOf[app?.icon?.color ?? ""] ?? "bg-gray",
          icon: app?.icon ?? undefined,
        });
        break;
      }
      case "system":
        system = {
          key: "system",
          name: "System and other",
          line: `${systemName(host)}, its swap space and logs`,
          bytes: part.bytes,
          colour: systemColour,
        };
    }
  }
  return [
    ...named.sort(bySize),
    ...own.sort(bySize),
    ...(system ? [system] : []),
  ];
}

// "Moods and Zigbee run inside it", until none do.
function insideWords(apps: readonly AppInfo[]) {
  if (apps.length === 0) return undefined;
  const inside = apps.filter((app) => !app.run).map((app) => app.name);
  if (inside.length === 0) return "On its own; each app has its own part";
  return `${listOf(inside)} ${inside.length === 1 ? "runs" : "run"} inside it`;
}

function memoryParts(
  parts: MemoryPart[],
  host: HostInfo,
  apps: readonly AppInfo[],
): Part[] {
  const named: Part[] = [];
  const own: Part[] = [];
  let system: Part | undefined;
  for (const part of parts) {
    switch (part.kind) {
      case "core":
        named.push({
          key: "core",
          name: productName,
          line: insideWords(apps),
          bytes: part.bytes,
          colour: "bg-purple",
        });
        break;
      case "manager":
        named.push({
          key: "manager",
          name: "Updates and services",
          line: `Keeps ${productName} running and up to date`,
          bytes: part.bytes,
          colour: "bg-green",
        });
        break;
      case "devBuilds":
        named.push({
          key: "devBuilds",
          name: "Dev builds",
          line: "Takes the builds pushed to update to",
          bytes: part.bytes,
          colour: "bg-pink",
        });
        break;
      case "service": {
        const look = serviceLooks[part.service];
        named.push({
          key: `service:${part.service}`,
          name: serviceName(part.service),
          line: look?.line,
          bytes: part.bytes,
          colour: look?.colour ?? "bg-yellow",
        });
        break;
      }
      case "app": {
        const app = apps.find((each) => each.id === part.app);
        const services = part.services.map(
          (service) => serviceWords[service] ?? service,
        );
        own.push({
          key: `app:${part.app}`,
          name: app?.name ?? part.app,
          line:
            services.length > 0
              ? `With ${listOf(services)}, which it uses`
              : undefined,
          bytes: part.bytes,
          colour: colourOf[app?.icon?.color ?? ""] ?? "bg-gray",
          icon: app?.icon ?? undefined,
        });
        break;
      }
      case "system":
        system = {
          key: "system",
          name: "System and other",
          line: `${systemName(host)} and what it runs`,
          bytes: part.bytes,
          colour: systemColour,
        };
    }
  }
  return [
    ...named.sort(bySize),
    ...own.sort(bySize),
    ...(system ? [system] : []),
  ];
}

function listOf(names: readonly string[]) {
  return names.length < 2
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

const spokenParts = (parts: Part[], format: (bytes: number) => string) =>
  parts.map((part) => `${part.name} ${format(part.bytes)}`).join(", ");

export function StorageSection(props: {
  host: HostInfo;
  problems: HostProblem[];
  apps: readonly AppInfo[];
  space: Space;
}) {
  const { storage } = props.host;
  if (!storage) return null;
  const parts = storageParts(storage.parts, props.host, props.apps);
  const hint = `${formatBytes(storage.free)} free of ${formatBytes(storage.total)}`;
  return (
    <Section
      id="status-storage"
      title="Storage"
      hint={hint}
      problem={props.problems.some((each) => each.kind === "storage")}
    >
      <Bar
        parts={parts}
        total={storage.total}
        label={`Storage, ${hint}: ${spokenParts(parts, formatBytes)}`}
      />
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {parts.map((part) => (
          <PartRow key={part.key} part={part} size={formatBytes(part.bytes)} />
        ))}
      </ul>
      <OldVersionsRow space={props.space} />
    </Section>
  );
}

export function MemorySection(props: {
  host: HostInfo;
  problems: HostProblem[];
  apps: readonly AppInfo[];
}) {
  const { memory } = props.host;
  if (!memory) return null;
  const parts = memoryParts(memory.parts, props.host, props.apps);
  const short = props.problems.some((each) => each.kind === "memory");
  const hint = `${formatMemory(memory.available)} free of ${formatMemory(memory.total)}`;
  return (
    <Section id="status-memory" title="Memory" hint={hint} problem={short}>
      <Bar
        parts={parts}
        total={memory.total}
        label={`Memory, ${hint}: ${spokenParts(parts, formatMemory)}${
          memory.swapUsed > 0
            ? `. Swap ${formatMemory(memory.swapUsed)} in use`
            : ""
        }`}
      />
      <ul className="m-0 flex list-none flex-col gap-3 p-0">
        {memory.swapUsed > 0 && (
          <PartRow
            part={{
              key: "swap",
              name: "Swap in use",
              line: "Its storage stands in for memory, which is slower",
              bytes: memory.swapUsed,
              colour: "",
            }}
            size={formatMemory(memory.swapUsed)}
            outside
            problem={short}
          />
        )}
        {parts.map((part) => (
          <PartRow key={part.key} part={part} size={formatMemory(part.bytes)} />
        ))}
      </ul>
    </Section>
  );
}

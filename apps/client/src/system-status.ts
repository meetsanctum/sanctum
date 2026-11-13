import type { TemperatureUnit } from "@meetsanctum/app-sdk";
import { formatTemperature } from "@meetsanctum/ui-sdk";
import { useEffect, useState } from "react";

import { productName } from "./brand";
import { coreJson } from "./core-fetch";
import { timeText } from "./device-history-data";
import type { Channel } from "./system-update";

// The host's status (apps/core/src/system/status.ts), for Settings → Status,
// System's row, Needs attention and the dashboard's Attention tile, in the
// words they share. Sizes are in bytes.

export type HostProblem =
  | { kind: "power"; lastLowAt: string }
  | { kind: "storage"; free: number }
  | { kind: "heat"; celsius: number }
  | { kind: "memory"; available: number; total: number }
  | {
      kind: "service";
      service: string;
      state: "failed" | "waiting";
      problem: string | null;
      apps: string[];
    }
  | { kind: "clock" }
  | { kind: "memoryLimits" }
  | { kind: "appData"; app: string; state: "missing" | "damaged" };

export type StoragePart =
  | { kind: "devBuilds" | "software" | "system"; bytes: number }
  | { kind: "home"; bytes: number; data: number; backups: number }
  | { kind: "app"; app: string; bytes: number };

export type MemoryPart =
  | { kind: "core" | "manager" | "devBuilds" | "system"; bytes: number }
  | { kind: "app"; app: string; bytes: number; services: string[] }
  | { kind: "service"; service: string; bytes: number };

export type HostInfo = {
  model: string | null;
  os: string | null;
  bits: 32 | 64 | null;
  uptimeSeconds: number | null;
  hostname: string | null;
  memory: {
    total: number;
    available: number;
    swapTotal: number;
    swapUsed: number;
    parts: MemoryPart[];
  } | null;
  storage: { total: number; free: number; parts: StoragePart[] } | null;
  processor: {
    cores: number;
    usage: number | null;
    mhz: number | null;
    celsius: number | null;
  };
  power: { low: boolean; lastLowAt: string | null } | null;
  network: {
    interface: string;
    kind: "wifi" | "ethernet" | "other";
    address: string | null;
    signalDbm: number | null;
    speedMbps: number | null;
  } | null;
  clock: boolean | null;
};

export type SystemStatus = {
  checkedAt: string;
  version: string;
  // Null, with the host, while Sanctum's updates and services don't answer.
  channel: Channel | null;
  host: HostInfo | null;
  problems: HostProblem[];
};

export const systemStatus = {
  get: () => coreJson<SystemStatus>("/api/system/status"),
};

/** The host's status, asked now and every `everyMs` while `enabled`; failed while the core doesn't answer. */
export function useSystemStatus(options: {
  enabled: boolean;
  everyMs: number;
}) {
  const { enabled, everyMs } = options;
  const [status, setStatus] = useState<SystemStatus>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let isStopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      try {
        const answer = await systemStatus.get();
        if (isStopped) return;
        setStatus(answer);
        setFailed(false);
      } catch {
        if (isStopped) return;
        setFailed(true);
      }
      timer = setTimeout(load, everyMs);
    };
    void load();
    return () => {
      isStopped = true;
      clearTimeout(timer);
    };
  }, [enabled, everyMs]);
  return { status, failed };
}

// The services' names, as the activity log and Status show them.
export const serviceNames: Record<string, string> = {
  zigbee2mqtt: "Zigbee",
  mosquitto: "Messaging",
};

export const serviceName = (service: string) =>
  serviceNames[service] ?? service;

// Figures to three places, as Finder and iOS show sizes: "1.35 GB",
// "15.1 GB", "164 MB".
const figures = new Intl.NumberFormat(undefined, {
  maximumSignificantDigits: 3,
});

function scaled(bytes: number, base: number) {
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / base;
  let unit = 0;
  while (value >= base && unit < units.length - 1) {
    value /= base;
    unit += 1;
  }
  return `${figures.format(value)} ${units[unit]}`;
}

/** Storage in decimal units, as Finder counts it. */
export function formatBytes(bytes: number) {
  if (bytes > 0 && bytes < 1000) return "under 1 KB";
  return scaled(bytes, 1000);
}

/** Memory in binary units, as Activity Monitor counts it. */
export function formatMemory(bytes: number) {
  if (bytes > 0 && bytes < 1024) return "under 1 KB";
  return scaled(bytes, 1024);
}

/** The memory a machine is sold with: what the kernel has, rounded up. */
export const memorySize = (total: number) =>
  `${Math.ceil(total / 1024 ** 3)} GB`;

/** "Raspberry Pi 4 Model B, 8 GB". */
export function modelText(host: HostInfo) {
  if (!host.model) return null;
  return host.memory
    ? `${host.model}, ${memorySize(host.memory.total)}`
    : host.model;
}

/** "Debian 13 (trixie), 64-bit". */
export function osText(host: HostInfo) {
  if (!host.os) return null;
  const name = host.os.replace(" GNU/Linux", "");
  return host.bits ? `${name}, ${host.bits}-bit` : name;
}

// "Debian", for what the system holds.
export const systemName = (host: HostInfo) =>
  host.os?.split(" ")[0] ?? "The system";

/** How long the host has run: "4 days, 21 hours", "2 hours, 12 minutes". */
export function runningFor(seconds: number) {
  const plural = (count: number, word: string) =>
    `${count} ${word}${count === 1 ? "" : "s"}`;
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  if (days > 0) {
    return hours > 0
      ? `${plural(days, "day")}, ${plural(hours, "hour")}`
      : plural(days, "day");
  }
  if (hours > 0) {
    return minutes > 0
      ? `${plural(hours, "hour")}, ${plural(minutes, "minute")}`
      : plural(hours, "hour");
  }
  return plural(Math.max(1, minutes), "minute");
}

/** Wi-Fi's signal in a word, by its level in dBm. */
export function signalWord(dbm: number) {
  if (dbm >= -50) return "excellent";
  if (dbm >= -60) return "good";
  if (dbm >= -70) return "fair";
  return "weak";
}

export function connectionText(network: NonNullable<HostInfo["network"]>) {
  switch (network.kind) {
    case "wifi":
      return network.signalDbm === null
        ? "Wi-Fi"
        : `Wi-Fi · signal ${signalWord(network.signalDbm)}`;
    case "ethernet":
      return network.speedMbps === null
        ? "Ethernet"
        : `Ethernet · ${
            network.speedMbps >= 1000
              ? `${figures.format(network.speedMbps / 1000)} Gb/s`
              : `${network.speedMbps} Mb/s`
          }`;
    default:
      return network.interface;
  }
}

/** "4 cores at 1.8 GHz". */
export function processorText(processor: HostInfo["processor"]) {
  const speed =
    processor.mhz === null
      ? null
      : processor.mhz >= 1000
        ? `${figures.format(processor.mhz / 1000)} GHz`
        : `${processor.mhz} MHz`;
  const cores = `${processor.cores} core${processor.cores === 1 ? "" : "s"}`;
  return speed ? `${cores} at ${speed}` : cores;
}

// Where a Raspberry Pi slows itself down, and where it gets close.
export const hotCelsius = 80;
const warmCelsius = 70;

export function temperatureWord(celsius: number) {
  if (celsius >= hotCelsius) return "too hot";
  if (celsius >= warmCelsius) return "warm";
  return "normal";
}

const temperature = (celsius: number, unit: TemperatureUnit) =>
  formatTemperature(celsius, unit, { whole: true });

/** "18:40", or "1 Nov, 18:40" before today. */
export function lastAtText(iso: string, now = new Date()) {
  const at = new Date(iso);
  const time = timeText(at.getTime());
  return at.toDateString() === now.toDateString()
    ? time
    : `${at.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
}

// What an app's name is, for the fix of a problem with its data.
type AppNames = (id: string) => string;

/** A problem in a few words, leading its row: "Power supply too weak". */
export function problemTitle(problem: HostProblem, unit: TemperatureUnit) {
  switch (problem.kind) {
    case "power":
      return "Power supply too weak";
    case "storage":
      return `Storage almost full, ${formatBytes(problem.free)} free`;
    case "heat":
      return `Too hot, ${temperature(problem.celsius, unit)}`;
    case "memory":
      return "Short of memory";
    case "service":
      return problem.state === "failed"
        ? `${serviceName(problem.service)} stopped`
        : `${serviceName(problem.service)} isn't running`;
    case "clock":
      return "Clock not synchronised";
    case "memoryLimits":
      return "Memory limits are off";
    case "appData":
      return problem.state === "damaged"
        ? "An app's data is damaged"
        : "An app's data is missing";
  }
}

// What a service's own problem means, and what to do. The manager says
// why it can't start Zigbee's bridge; anything else starts again by itself.
// An adapter of a type the manager can't tell is chosen on the command
// line, which the install guide shows.
function serviceFix(problem: Extract<HostProblem, { kind: "service" }>) {
  const text = problem.problem ?? "";
  if (text.startsWith("No Zigbee coordinator")) {
    return "No Zigbee adapter is plugged in. Plug it in, and Zigbee starts by itself";
  }
  if (/^The Zigbee coordinator .* is not plugged in/.test(text)) {
    return "The Zigbee adapter it uses isn't plugged in. Plug it in again, and Zigbee starts by itself";
  }
  if (text.startsWith("Several possible Zigbee coordinators")) {
    return "Several Zigbee adapters are plugged in. Unplug the ones it shouldn't use";
  }
  if (text.startsWith("Choose the adapter type")) {
    return `${productName} doesn't recognise this Zigbee adapter's type by itself. The install guide says how to choose it, under “Zigbee does not start”`;
  }
  return `${productName} starts it again by itself`;
}

/** What to do about a problem, under its title. */
export function problemFix(
  problem: HostProblem,
  appName: AppNames,
  now = new Date(),
) {
  switch (problem.kind) {
    case "power":
      return `Use the official one: too little power can damage ${productName}'s data. Last at ${lastAtText(problem.lastLowAt, now)}`;
    case "storage":
      return `An update needs 1.5 GB free: move ${productName} to a larger card or drive`;
    case "heat":
      return "It has slowed down to cool off. Give it room to breathe, or a case with a fan";
    case "memory":
      return `It's using its storage as memory, so ${productName} may be slow`;
    case "service":
      return serviceFix(problem);
    case "memoryLimits":
      return `An app can use more memory than it should until they're on in ${productName}'s boot settings`;
    case "appData":
      return `${appName(problem.app)} can't start until its data is back`;
    case "clock":
      return `Devices may refuse ${productName}'s certificate until it is: check that ${productName} can reach the internet`;
  }
}

/** A problem in a word or two, for the dashboard's Attention tile. */
export function problemShort(problem: HostProblem) {
  switch (problem.kind) {
    case "power":
      return "Power too weak";
    case "storage":
      return "Storage almost full";
    case "heat":
      return "Too hot";
    case "memory":
      return "Short of memory";
    case "service":
      return `${serviceName(problem.service)} stopped`;
    case "clock":
      return "Clock not set";
    case "memoryLimits":
      return "Memory limits off";
    case "appData":
      return problem.state === "damaged"
        ? "App data damaged"
        : "App data missing";
  }
}

/** What the verdict says is fine: "Storage, memory, temperature and power are fine". */
export function fineText(host: HostInfo) {
  const checked = [
    host.storage && "storage",
    host.memory && "memory",
    host.processor.celsius !== null && "temperature",
    host.power && "power",
  ].filter((each): each is string => typeof each === "string");
  if (checked.length === 0) return "Nothing needs you";
  const list =
    checked.length === 1
      ? checked[0]!
      : `${checked.slice(0, -1).join(", ")} and ${checked.at(-1)}`;
  return `${list[0]!.toUpperCase()}${list.slice(1)} ${checked.length === 1 ? "is" : "are"} fine`;
}

/** What follows "Everything's running" on System's row: "6.92 GB free · 57°C". */
export function fineDetail(host: HostInfo, unit: TemperatureUnit) {
  return [
    host.storage && `${formatBytes(host.storage.free)} free`,
    host.processor.celsius !== null &&
      temperature(host.processor.celsius, unit),
  ]
    .filter(Boolean)
    .join(" · ");
}

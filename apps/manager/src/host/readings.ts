import { readdir, readFile, statfs } from "node:fs/promises";
import { cpus, hostname, networkInterfaces } from "node:os";
import { join } from "node:path";

// What the host's kernel says about it, as the manager's container sees it
// (Settings → System). /proc and /sys are the host's, apart from the device
// tree, which Docker masks, and the manager shares the host's network. Each
// reading is null where this host can't say, as on a machine that isn't a
// Raspberry Pi.

export type MemoryReading = {
  total: number;
  available: number;
  swapTotal: number;
  swapFree: number;
};

export type NetworkReading = {
  interface: string;
  kind: "wifi" | "ethernet" | "other";
  address: string | null;
  cidr?: string;
  // Wi-Fi's signal, in dBm, and Ethernet's link speed, in Mb/s.
  signalDbm: number | null;
  speedMbps: number | null;
};

// The busy and total time of every core together, from /proc/stat's first
// line, in clock ticks since the host started.
export type CpuTimes = { busy: number; total: number };

// The model a Raspberry Pi's kernel adds to /proc/cpuinfo, without its board
// revision: "Raspberry Pi 4 Model B Rev 1.4" → "Raspberry Pi 4 Model B".
function modelOf(cpuinfo: string) {
  const match = /^Model[ \t]*:[ \t]*(\S.*)/m.exec(cpuinfo);
  return match ? match[1]!.replace(/\s+Rev\s+[\w.]+$/, "").trim() : null;
}

/** The processor's name, as x86's cpuinfo gives it: "Intel(R) N150". */
function processorNameOf(cpuinfo: string) {
  const match = /^model name[ \t]*:[ \t]*(\S.*)/m.exec(cpuinfo);
  return match ? match[1]!.replace(/\s+/g, " ").trim() : null;
}

/**
 * Whether the processor has the vector instructions an AI model runs
 * quickly on without graphics: AVX2 on x86, or the dot product (asimddp) on
 * ARM. Null where cpuinfo names neither kind of flags.
 */
function matrixInstructionsOf(cpuinfo: string) {
  const flags = /^(?:flags|Features)[ \t]*:[ \t]*(\S.*)/m.exec(cpuinfo);
  if (!flags) return null;
  return /(?:^|\s)(?:avx2|asimddp)(?:\s|$)/.test(flags[1]!);
}

const kib = 1024;

export function memoryField(meminfo: string, name: string) {
  const match = new RegExp(`^${name}:[ \\t]+(\\d+) kB$`, "m").exec(meminfo);
  return match ? Number(match[1]) * kib : null;
}

export function memoryOf(meminfo: string): MemoryReading | null {
  const field = (name: string) => memoryField(meminfo, name);
  const total = field("MemTotal");
  const available = field("MemAvailable");
  if (total === null || available === null) return null;
  return {
    total,
    available,
    swapTotal: field("SwapTotal") ?? 0,
    swapFree: field("SwapFree") ?? 0,
  };
}

export function cpuTimesOf(stat: string): CpuTimes | null {
  const line = /^cpu\s+(.+)$/m.exec(stat);
  if (!line) return null;
  const ticks = line[1]!.trim().split(/\s+/).map(Number);
  if (ticks.length < 4 || ticks.some((each) => !Number.isFinite(each))) {
    return null;
  }
  // user nice system idle iowait irq softirq steal: idle and iowait wait.
  const idle = ticks[3]! + (ticks[4] ?? 0);
  const total = ticks.slice(0, 8).reduce((sum, each) => sum + each, 0);
  return { busy: total - idle, total };
}

// How busy the processor was between two readings, from 0 to 1.
export function usageBetween(before: CpuTimes, after: CpuTimes) {
  const total = after.total - before.total;
  if (total <= 0) return null;
  return Math.min(1, Math.max(0, (after.busy - before.busy) / total));
}

// The interface the default route leaves by, from /proc/net/route.
export function defaultInterfaceOf(route: string) {
  for (const line of route.split("\n").slice(1)) {
    const [name, destination] = line.trim().split(/\s+/);
    if (name && destination === "00000000") return name;
  }
  return null;
}

// A Wi-Fi interface's signal level in dBm, from /proc/net/wireless.
export function signalOf(wireless: string, name: string) {
  for (const line of wireless.split("\n").slice(2)) {
    const [field, , , level] = line.trim().split(/\s+/);
    if (field === `${name}:` && level !== undefined) {
      const dbm = Number.parseFloat(level);
      return Number.isFinite(dbm) ? dbm : null;
    }
  }
  return null;
}

function kindOf(name: string): NetworkReading["kind"] {
  if (/^(wlan|wl)/.test(name)) return "wifi";
  if (/^(eth|en)/.test(name)) return "ethernet";
  return "other";
}

export function createHostReadings(
  options: {
    // Where /proc and /sys are, and the interfaces' addresses, for tests.
    root?: string;
    interfaces?: typeof networkInterfaces;
  } = {},
) {
  const root = options.root ?? "/";
  const interfaces = options.interfaces ?? networkInterfaces;
  const path = (...parts: string[]) => join(root, ...parts);
  const text = (...parts: string[]) =>
    readFile(path(...parts), "utf8").catch(() => null);
  const number = async (...parts: string[]) => {
    const value = Number.parseInt((await text(...parts)) ?? "", 10);
    return Number.isFinite(value) ? value : null;
  };

  // The first hardware monitor of a name, such as a Pi's rpi_volt.
  async function hwmon(name: string) {
    const dir = path("sys/class/hwmon");
    const entries = await readdir(dir).catch(() => [] as string[]);
    for (const entry of entries.sort()) {
      if ((await text("sys/class/hwmon", entry, "name"))?.trim() === name) {
        return join("sys/class/hwmon", entry);
      }
    }
    return null;
  }

  return {
    async processor() {
      const cpuinfo = (await text("proc/cpuinfo")) ?? "";
      return {
        model: modelOf(cpuinfo),
        processor: {
          name: processorNameOf(cpuinfo),
          cores: cpus().length,
          matrixInstructions: matrixInstructionsOf(cpuinfo),
        },
      };
    },

    async uptimeSeconds() {
      const uptime = await text("proc/uptime");
      const seconds = Number.parseFloat(uptime ?? "");
      return Number.isFinite(seconds) ? Math.floor(seconds) : null;
    },

    async memory() {
      const meminfo = await text("proc/meminfo");
      return meminfo ? memoryOf(meminfo) : null;
    },

    async cpuTimes() {
      const stat = await text("proc/stat");
      return stat ? cpuTimesOf(stat) : null;
    },

    // The first core's speed now, in MHz.
    async mhz() {
      const khz = await number(
        "sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq",
      );
      return khz === null ? null : Math.round(khz / 1000);
    },

    // The processor's temperature, in °C.
    async celsius() {
      const millis = await number("sys/class/thermal/thermal_zone0/temp");
      return millis === null ? null : Math.round(millis / 100) / 10;
    },

    // Whether a Raspberry Pi's supply is too weak right now: its firmware
    // raises the rpi_volt monitor's alarm while the voltage is under
    // 4.63 V. Null on a machine without one.
    async lowVoltage() {
      const monitor = await hwmon("rpi_volt");
      if (!monitor) return null;
      const alarm = await number(monitor, "in0_lcrit_alarm");
      return alarm === null ? null : alarm !== 0;
    },

    // The disk a folder is on: its size, occupied space and space available
    // for its files. Reserved free blocks are unoccupied but unavailable.
    async disk(folder: string) {
      try {
        const stats = await statfs(folder);
        return {
          total: stats.blocks * stats.bsize,
          used: (stats.blocks - stats.bfree) * stats.bsize,
          free: stats.bavail * stats.bsize,
        };
      } catch {
        return null;
      }
    },

    // How the host reaches the network: the interface of its default route.
    async network(): Promise<NetworkReading | null> {
      const route = await text("proc/net/route");
      const name = route ? defaultInterfaceOf(route) : null;
      if (!name) return null;
      const kind = kindOf(name);
      const ipv4 = interfaces()[name]?.find(
        (each) => each.family === "IPv4" && !each.internal,
      );
      const wireless = kind === "wifi" ? await text("proc/net/wireless") : null;
      const speed =
        kind === "ethernet"
          ? await number("sys/class/net", name, "speed")
          : null;
      return {
        interface: name,
        kind,
        address: ipv4?.address ?? null,
        ...(ipv4?.cidr && { cidr: ipv4.cidr }),
        signalDbm: wireless ? signalOf(wireless, name) : null,
        // An interface without a link says -1.
        speedMbps: speed !== null && speed > 0 ? speed : null,
      };
    },

    hostname: () => hostname(),
  };
}

export type HostReadings = ReturnType<typeof createHostReadings>;

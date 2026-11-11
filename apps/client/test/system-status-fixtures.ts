import type { AppIcon, AppInfo } from "@meetsanctum/app-sdk";

import type { SystemStatus } from "../src/system-status";

// The dev Pi's status as the core answers it (2026-11-02): a Raspberry Pi 4
// with 8 GB and a 15 GB card on Wi-Fi, running Zigbee's bridge and broker
// and the dev channel's registry.
export function piStatus(changes: Partial<SystemStatus> = {}): SystemStatus {
  return {
    checkedAt: "2026-11-02T19:41:00.000Z",
    version: "dev-ed4f70b",
    channel: "dev",
    host: {
      model: "Raspberry Pi 4 Model B",
      os: "Debian GNU/Linux 13 (trixie)",
      bits: 64,
      uptimeSeconds: 421_763,
      hostname: "sanctum-dev",
      memory: {
        total: 8_199_577_600,
        available: 7_542_419_456,
        swapTotal: 2_147_479_552,
        swapUsed: 0,
        parts: [
          { kind: "core", bytes: 171_470_848 },
          { kind: "manager", bytes: 109_514_752 },
          { kind: "service", service: "zigbee2mqtt", bytes: 138_272_768 },
          { kind: "service", service: "mosquitto", bytes: 8_204_288 },
          { kind: "devBuilds", bytes: 45_862_912 },
          { kind: "system", bytes: 183_832_576 },
        ],
      },
      storage: {
        total: 15_072_243_712,
        free: 6_917_287_936,
        parts: [
          { kind: "devBuilds", bytes: 1_349_000_000 },
          { kind: "software", bytes: 1_207_000_000 },
          {
            kind: "home",
            bytes: 28_700_000,
            data: 11_300_000,
            backups: 17_400_000,
          },
          { kind: "app", app: "sanctum.zigbee", bytes: 330_000 },
          { kind: "app", app: "sanctum.moods", bytes: 180_000 },
          { kind: "system", bytes: 5_569_955_776 },
        ],
      },
      processor: { cores: 4, usage: 0.03, mhz: 1800, celsius: 57.5 },
      power: { low: false, lastLowAt: null },
      network: {
        interface: "wlan0",
        kind: "wifi",
        address: "192.168.3.222",
        signalDbm: -37,
        speedMbps: null,
      },
      clock: true,
    },
    problems: [],
    ...changes,
  };
}

const app = (
  id: string,
  name: string,
  glyph: string,
  color: AppIcon["color"],
): AppInfo => ({
  id,
  name,
  version: "1.0.0",
  icon: { glyph, color },
  pages: [],
  permissions: [],
  requests: [],
  state: "running",
  settings: null,
  provides: { entities: [], widgets: [], roomSections: [], devicePages: [] },
});

export const statusApps: AppInfo[] = [
  app("sanctum.moods", "Moods", "sparkles", "ember"),
  app("sanctum.zigbee", "Zigbee", "radio-tower", "graphite"),
];

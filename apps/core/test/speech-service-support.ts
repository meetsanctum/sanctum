import type { DeviceInfo } from "@meetsanctum/app-sdk";
import { onTestFinished } from "vitest";

import { createAnnouncements } from "../src/speech/announcements.js";
import { createSpeech } from "../src/speech/speech.js";
import type { SpeechAudio } from "../src/speech/wyoming.js";

export const speaker = (id: string, announces: boolean) =>
  ({
    id,
    name: "Office Speaker",
    availability: "online",
    capabilities: [
      {
        id: "audio",
        kind: "audio",
        features: { mutes: true, muteSwitch: true, announces },
      },
    ],
  }) as unknown as DeviceInfo;

export function setupSpeech(options: {
  devices: DeviceInfo[];
  areaOn?: boolean;
  serviceUrl?: string | null;
  getServiceUrl?: () => Promise<string | null>;
  getAddress?: () => string;
  address?: string | null;
  cidr?: string;
  want?: (signal: AbortSignal) => Promise<void>;
  chime?: readonly SpeechAudio[];
  errorChime?: readonly SpeechAudio[];
  hears?: () => boolean;
  log?: (message: string) => void;
}) {
  const calls: string[] = [];
  const told: { device: string; url: string }[] = [];
  let areaOn = options.areaOn ?? true;
  const announcements = createAnnouncements({
    host: "127.0.0.1",
    port: 0,
    log: () => {},
  });
  onTestFinished(() => announcements.stop());
  const speech = createSpeech({
    announcements,
    manager: {
      serviceUrl:
        options.getServiceUrl ?? (async () => options.serviceUrl ?? null),
      hostStatus: async () => ({
        network:
          options.address === null
            ? null
            : {
                address:
                  options.getAddress?.() ?? options.address ?? "192.168.1.20",
                cidr: options.cidr ?? "192.168.1.20/24",
              },
      }),
      wantServiceForCore: async (service, { signal }) => {
        calls.push(`want ${service}`);
        await options.want?.(signal);
      },
      releaseServiceForCore: async (service) =>
        void calls.push(`release ${service}`),
    },
    devices: {
      list: () => options.devices,
      announce: async (device, url, _actor, fetched) => {
        if (!fetched) told.push({ device, url });
      },
    },
    areaOn: () => areaOn,
    ...(options.hears ? { hears: options.hears } : {}),
    publishedPort: 4180,
    ...(options.chime ? { chime: options.chime } : {}),
    ...(options.errorChime ? { errorChime: options.errorChime } : {}),
    log: options.log ?? (() => {}),
  });
  return {
    announcements,
    speech,
    calls,
    told,
    setArea(on: boolean) {
      areaOn = on;
      speech.areaChanged();
    },
  };
}

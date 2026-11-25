import { setTimeout as delay } from "node:timers/promises";

import type { Actor, DeviceInfo } from "@meetsanctum/app-sdk";

import type { DeviceChange } from "../devices/devices.js";
import { speakerNetwork, type Announcements } from "./announcements.js";
import { synthesize } from "./wyoming.js";

// What Sanctum says out loud, in the home's one voice per language. Piper,
// a service the manager runs, turns the words into speech; the core encodes
// it and serves it to the smart speaker that plays it (announcements.ts).
// Piper runs only while a smart speaker in the home can announce and AI
// agents may speak on them, so a home without one pays nothing for it.

/** The voices Sanctum speaks in, each trained on recordings free to use. */
export const voices = {
  en: "en_US-norman-medium",
  de: "de_DE-thorsten-medium",
} as const;
export type SpeechLanguage = keyof typeof voices;
export const speechLanguages = Object.keys(voices) as SpeechLanguage[];

/** The service the manager runs for it. */
export const speechService = "piper";

/** How long Piper may stay quiet: a voice's first use downloads it. */
const speechIdleMs = 30_000;
/** How often to look for the service while it starts, and for how long. */
const startingEveryMs = 10_000;
const startingForMs = 15 * 60_000;
/** How long the host's address on the home's network is taken as known. */
const addressKeptMs = 5 * 60_000;

export class SpeechUnavailable extends Error {}

type Manager = {
  serviceUrl(service: string): Promise<string | null>;
  wantServiceForCore(
    service: string,
    options: { signal: AbortSignal },
  ): Promise<void>;
  releaseServiceForCore(
    service: string,
    options: { signal: AbortSignal },
  ): Promise<void>;
  hostStatus(): Promise<{
    network: { address: string | null; cidr?: string } | null;
  }>;
};

const announces = (device: DeviceInfo | null) =>
  device?.capabilities.some(
    (capability) =>
      capability.kind === "audio" &&
      (capability.features as { announces?: boolean }).announces === true,
  ) ?? false;

/** Where a Wyoming service listens, from its `tcp://host:port`. */
function endpointOf(url: string) {
  const parsed = URL.parse(url);
  if (!parsed) return null;
  const port = Number(parsed.port);
  if (parsed.protocol !== "tcp:" || !parsed.hostname || !port) return null;
  return { host: parsed.hostname, port };
}

export function createSpeech(options: {
  announcements: Announcements;
  manager: Manager;
  devices: {
    list(): DeviceInfo[];
    announce(device: string, url: string, actor: Actor): Promise<void>;
  };
  // Whether AI agents may speak on smart speakers.
  areaOn: () => boolean;
  // The port speakers fetch announcements on, as the host publishes it.
  publishedPort: number;
  log: (message: string) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const announcers = new Set<string>();
  let desired: boolean | null = null;
  let changing: AbortController | null = null;
  let warming: AbortController | null = null;
  let address: {
    value: NonNullable<ReturnType<typeof speakerNetwork>>;
    at: number;
  } | null = null;
  let running = false;

  async function hostNetwork() {
    if (address && now() - address.at < addressKeptMs) return address.value;
    const status = await options.manager.hostStatus().catch(() => null);
    const network = status?.network;
    const value =
      network?.address && network.cidr
        ? speakerNetwork(network.address, network.cidr)
        : null;
    address = value ? { value, at: now() } : null;
    return value;
  }

  async function endpoint() {
    const url = await options.manager
      .serviceUrl(speechService)
      .catch(() => null);
    return url ? endpointOf(url) : null;
  }

  // Once the service runs, each voice is spoken once, so its download and
  // load happen now rather than in someone's first announcement.
  async function warm(signal: AbortSignal) {
    const until = now() + startingForMs;
    while (!signal.aborted && now() < until) {
      const at = await endpoint();
      if (signal.aborted) return;
      if (at) {
        for (const language of speechLanguages) {
          if (signal.aborted) return;
          try {
            const spoken = synthesize({
              ...at,
              text: ".",
              voice: voices[language],
              idleMs: 120_000,
              signal,
            });
            // Only the voice's loading counts, not what it says.
            while (!(await spoken.next()).done);
          } catch (error) {
            if (signal.aborted) return;
            options.log(
              `Speech couldn't load its ${language} voice: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
        return;
      }
      try {
        await delay(startingEveryMs, undefined, { signal, ref: false });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  }

  // Only one manager write at a time. A setting change cancels retries
  // and applies the newest state after the previous attempt settles.
  async function applyServiceState() {
    while (running && desired !== null) {
      const want: boolean = desired;
      const change = new AbortController();
      changing = change;
      try {
        if (want) {
          await options.manager.wantServiceForCore(speechService, {
            signal: change.signal,
          });
        } else {
          await options.manager.releaseServiceForCore(speechService, {
            signal: change.signal,
          });
        }
        if (running && !change.signal.aborted && want) {
          warming = new AbortController();
          const signal = warming.signal;
          void warm(signal).catch((error: unknown) => {
            if (!signal.aborted)
              options.log(`Speech warmup failed: ${String(error)}`);
          });
        }
      } catch (error) {
        if (!change.signal.aborted) {
          desired = null;
          options.log(
            `Speech couldn't ${want ? "start" : "stop"}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      } finally {
        changing = null;
      }
      if (!change.signal.aborted) return;
    }
  }

  function reconcile() {
    if (!running) return;
    const want = options.areaOn() && announcers.size > 0;
    if (want === desired) return;
    desired = want;
    warming?.abort();
    warming = null;
    if (changing) changing.abort();
    else void applyServiceState();
  }

  return {
    start() {
      if (running || options.announcements.port() === null) return;
      running = true;
      announcers.clear();
      for (const device of options.devices.list()) {
        if (announces(device)) announcers.add(device.id);
      }
      reconcile();
    },

    deviceChanged(change: DeviceChange) {
      const had = announcers.has(change.id);
      const has = announces(change.after);
      if (had === has) return;
      if (has) announcers.add(change.id);
      else announcers.delete(change.id);
      reconcile();
    },

    areaChanged() {
      reconcile();
    },

    /**
     * Says `text` on a smart speaker in the language's voice, as `actor`:
     * resolves once the speaker has been told to play it, with whether all
     * of it was then encoded still to come. Throws SpeechUnavailable while
     * the speech service or the host's address isn't there, and the
     * announcement's own refusal while the speaker is still speaking.
     */
    async speak(input: {
      device: string;
      text: string;
      language: SpeechLanguage;
      actor: Actor;
    }) {
      if (!running || options.announcements.port() === null) {
        throw new SpeechUnavailable(
          "Speech isn't running on Sanctum right now",
        );
      }
      const [at, network] = await Promise.all([endpoint(), hostNetwork()]);
      const listenerPort = options.announcements.port();
      if (!running || listenerPort === null || !at || !network) {
        throw new SpeechUnavailable(
          "Speech isn't running on Sanctum right now",
        );
      }
      const announcement = options.announcements.create(
        input.device,
        network,
        options.publishedPort || listenerPort,
        (signal) =>
          synthesize({
            ...at,
            text: input.text,
            voice: voices[input.language],
            idleMs: speechIdleMs,
            signal,
          }),
      );
      try {
        await options.devices.announce(
          input.device,
          announcement.url,
          input.actor,
        );
      } catch (error) {
        announcement.withdraw();
        throw error;
      }
      return { encoded: announcement.encoded, fetched: announcement.fetched };
    },

    stop() {
      running = false;
      desired = null;
      changing?.abort();
      warming?.abort();
      warming = null;
    },
  };
}

export type Speech = ReturnType<typeof createSpeech>;

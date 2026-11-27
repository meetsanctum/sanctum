import type { Actor, DeviceInfo } from "@meetsanctum/app-sdk";

import { TimedOut, withTimeout } from "../app-host/errors.js";
import { announcementCapability } from "../devices/announce.js";
import type { DeviceChange } from "../devices/devices.js";
import { speakerNetwork, type Announcements } from "./announcements.js";
import { listeningRunMs } from "./listening.js";
import { synthesize, type SpeechAudio } from "./wyoming.js";

// What Sanctum says out loud, in the home's one voice per language. Piper,
// a service the manager runs, turns the words into speech; the core encodes
// it and serves it to the smart speaker that plays it (announcements.ts).
// Piper runs when the home can use announcements or spoken replies.

/** The voices Sanctum speaks in, each trained on recordings free to use. */
export const voices = {
  en: "en_US-norman-medium",
  de: "de_DE-thorsten-medium",
} as const;
export type SpeechLanguage = keyof typeof voices;
type KeptPhrase = { language: SpeechLanguage; text: string };
export const speechLanguages = Object.keys(voices) as SpeechLanguage[];

/** The service the manager runs for it. */
export const speechService = "piper";

/** How long Piper may stay quiet: a voice's first use downloads it. */
const speechIdleMs = 30_000;
/** Leave time to answer before the connector's 60-second request timeout. */
const dispatchWithinMs = 50_000;
/** Allow the driver to report that the reply played before ending the run. */
const replyPlaybackGraceMs = 5_000;
/** How often to look for the service while it starts, and for how long. */
const startingEveryMs = 10_000;
const startingForMs = 15 * 60_000;
/** How long the host's address on the home's network is taken as known. */
const addressKeptMs = 5 * 60_000;

export class SpeechUnavailable extends Error {}
/** AI agents may no longer speak on smart speakers. */
export class SpeechSwitchedOff extends Error {}

// Waits `ms`, or less once `signal` aborts, without holding the process open.
function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    timer.unref?.();
    signal.addEventListener("abort", done, { once: true });
  });
}

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
    announce(
      device: string,
      url: string,
      actor: Actor,
      fetched?: true,
    ): Promise<void>;
  };
  // Whether AI agents may speak on smart speakers.
  areaOn: () => boolean;
  // Whether speech recognition is available for new requests.
  hears?: () => boolean;
  // The port speakers fetch announcements on, as the host publishes it.
  publishedPort: number;
  // The success chime a confirmation plays on a smart speaker, kept ready;
  // without one, a confirmation's words are said.
  chime?: readonly SpeechAudio[];
  // Words said the same each time, such as "One moment": said as each voice
  // loads, and kept. A function's are read each time, as an app's change.
  keptPhrases?: readonly KeptPhrase[] | (() => readonly KeptPhrase[]);
  log: (message: string) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const announcers = new Set<string>();
  const listeners = new Set<string>();
  let replying = 0;
  let desired: boolean | null = null;
  let changing: AbortController | null = null;
  let warming: AbortController | null = null;
  let address: {
    value: NonNullable<ReturnType<typeof speakerNetwork>>;
    at: number;
  } | null = null;
  let running = false;
  // Phrases said the same each time, once Piper has said them.
  const keptPhrases = (): readonly KeptPhrase[] => {
    const phrases = options.keptPhrases ?? [];
    return typeof phrases === "function" ? phrases() : phrases;
  };
  const keptSpeech = new Map<string, SpeechAudio[]>();
  const keyOf = (language: SpeechLanguage, text: string) =>
    `${language}\n${text}`;
  const isKept = (key: string) =>
    keptPhrases().some(({ language, text }) => keyOf(language, text) === key);

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
  // load happen now rather than in someone's first announcement. A service
  // the manager has only just started has an address before it listens,
  // and fetches its own default voice first, so a voice that fails is tried
  // again until the service has had its time to start.
  async function warm(signal: AbortSignal) {
    const until = now() + startingForMs;
    const failed = new Map<SpeechLanguage, unknown>(
      speechLanguages.map((language) => [language, undefined]),
    );
    while (!signal.aborted && now() < until) {
      const at = await endpoint();
      if (signal.aborted) return;
      if (at) {
        for (const language of failed.keys()) {
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
            for (const phrase of keptPhrases()) {
              if (phrase.language !== language || signal.aborted) continue;
              // Saying it keeps it.
              const saying = said(at, phrase.text, language, signal);
              while (!(await saying.next()).done);
            }
            failed.delete(language);
          } catch (error) {
            if (signal.aborted) return;
            failed.set(language, error);
          }
        }
        if (failed.size === 0) return;
      }
      await pause(startingEveryMs, signal);
    }
    if (signal.aborted) return;
    for (const [language, error] of failed) {
      options.log(
        error === undefined
          ? `Speech couldn't load its ${language} voice: the service didn't start`
          : `Speech couldn't load its ${language} voice: ${error instanceof Error ? error.message : String(error)}`,
      );
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
    const want =
      options.announcements.port() !== null &&
      ((options.areaOn() && announcers.size > 0) ||
        (options.hears?.() === true && listeners.size > 0) ||
        replying > 0);
    if (want === desired) return;
    desired = want;
    warming?.abort();
    warming = null;
    if (changing) changing.abort();
    else void applyServiceState();
  }

  // An announcement of `text` for a speaker, once it's playable and its
  // turn has come and `tell` has handed its address on. It is withdrawn if
  // that fails or takes too long.
  async function prepare(
    input: {
      device: string;
      text: string;
      language: SpeechLanguage;
      beforeTelling?: () => void;
      onSynthesisStarted?: () => void;
      signal?: AbortSignal;
    },
    how: {
      finishing: boolean;
      // A sound kept ready to play in place of the words, needing no Piper.
      sound?: readonly SpeechAudio[];
      tell: (url: string) => Promise<void>;
      onFetched?: (url: string) => Promise<void>;
      playbackGraceMs?: number;
      dispatchWithinMs?: number;
    },
  ) {
    const dispatchBy = now() + (how.dispatchWithinMs ?? dispatchWithinMs);
    const waitExpired = () =>
      new SpeechUnavailable(
        "The speaker didn't take the announcement in time.",
      );
    const unavailable = () =>
      new SpeechUnavailable("Speech isn't running on Sanctum right now");
    input.signal?.throwIfAborted();
    if (!running || options.announcements.port() === null) throw unavailable();
    const { sound } = how;
    const [at, network] = await Promise.all([
      sound ? null : endpoint(),
      hostNetwork(),
    ]);
    const listenerPort = options.announcements.port();
    input.signal?.throwIfAborted();
    if (!running || listenerPort === null || (!at && !sound) || !network) {
      throw unavailable();
    }
    if (now() >= dispatchBy) throw waitExpired();
    const announcement = options.announcements.create(
      input.device,
      network,
      options.publishedPort || listenerPort,
      (signal) => {
        if (sound || !at) return played(sound ?? []);
        input.onSynthesisStarted?.();
        return said(at, input.text, input.language, signal);
      },
      () => {
        // An unfetched URL can mean the host has moved to another address.
        if (address?.value === network) address = null;
      },
      how.onFetched,
      { finishing: how.finishing, playbackGraceMs: how.playbackGraceMs },
    );
    const withdraw = () => announcement.withdraw();
    input.signal?.addEventListener("abort", withdraw, { once: true });
    void announcement.playback.then(() =>
      input.signal?.removeEventListener("abort", withdraw),
    );
    const tell = async () => {
      // The speaker needs a playable frame, and those ahead of it must have
      // finished, before the driver gets the address.
      const playable = (await announcement.ready) && (await announcement.turn);
      input.signal?.throwIfAborted();
      if (!how.finishing && !options.areaOn()) throw new SpeechSwitchedOff();
      if (playable) {
        if (now() >= dispatchBy) throw waitExpired();
        input.beforeTelling?.();
        const url = announcement.dispatchUrl();
        if (url) {
          await how.tell(url);
          return;
        }
      }
      throw running
        ? new SpeechUnavailable("The announcement audio couldn't be generated.")
        : unavailable();
    };
    try {
      await withTimeout(tell(), Math.max(0, dispatchBy - now()));
    } catch (error) {
      announcement.withdraw();
      throw error instanceof TimedOut ? waitExpired() : error;
    }
    return announcement;
  }

  async function* played(sound: readonly SpeechAudio[]) {
    yield* sound;
  }

  // What Piper says for `text`, or what it said before for a phrase kept
  // ready, such as "One moment", so a reply that's always the same needs no
  // wait for Piper.
  function said(
    at: NonNullable<Awaited<ReturnType<typeof endpoint>>>,
    text: string,
    language: SpeechLanguage,
    signal: AbortSignal,
  ): AsyncIterable<SpeechAudio> & AsyncIterator<SpeechAudio> {
    const spoken = () =>
      synthesize({
        ...at,
        text,
        voice: voices[language],
        idleMs: speechIdleMs,
        signal,
      });
    const key = keyOf(language, text);
    if (!isKept(key)) return spoken();
    return (async function* () {
      const ready = keptSpeech.get(key);
      if (ready) {
        yield* ready;
        return;
      }
      const chunks: SpeechAudio[] = [];
      for await (const audio of spoken()) {
        chunks.push(audio);
        yield audio;
      }
      if (!signal.aborted && chunks.length > 0 && isKept(key)) {
        keptSpeech.set(key, chunks);
      }
    })();
  }

  function updateSpeaker(id: string, device: DeviceInfo | null) {
    const announces = Boolean(announcementCapability(device));
    const listens =
      device?.capabilities.some(
        (part) => part.kind === "audio" && part.features.listens,
      ) ?? false;
    if (announces === announcers.has(id) && listens === listeners.has(id))
      return false;
    if (announces) announcers.add(id);
    else announcers.delete(id);
    if (listens) listeners.add(id);
    else listeners.delete(id);
    return true;
  }

  return {
    pruneKeptPhrases() {
      const keys = new Set(
        keptPhrases().map(({ language, text }) => keyOf(language, text)),
      );
      for (const key of keptSpeech.keys()) {
        if (!keys.has(key)) keptSpeech.delete(key);
      }
    },

    start() {
      if (running) return;
      running = true;
      announcers.clear();
      listeners.clear();
      for (const device of options.devices.list()) {
        updateSpeaker(device.id, device);
      }
      reconcile();
    },

    deviceChanged(change: DeviceChange) {
      if (updateSpeaker(change.id, change.after)) reconcile();
    },

    /** Keeps Piper available through a request's last reply. */
    keepRepliesReady() {
      replying++;
      reconcile();
      return () => {
        replying--;
        reconcile();
      };
    },

    /**
     * Whether speech recognition runs changed: Piper runs for its replies
     * while it does, beside what announcements need.
     */
    hearingChanged() {
      reconcile();
    },

    areaChanged() {
      reconcile();
      // What hasn't reached a speaker yet isn't said once agents may not speak.
      if (!options.areaOn()) options.announcements.withdrawUnfetched();
    },

    /**
     * Says `text` on a smart speaker in the language's voice, as `actor`,
     * after what the speaker has still to say: resolves once the speaker has
     * been told to play it, with whether all of it was then encoded still to
     * come. `beforeTelling` runs then, and may throw to keep it from the
     * speaker, as when the speaker was muted while it waited. Throws
     * SpeechUnavailable while the speech service or the host's address isn't
     * there or the speech fails before any sound, SpeechSwitchedOff once AI
     * agents may no longer speak before the speaker is told, and the
     * announcement's own refusal while too many wait. A request's reply
     * that follows its "One moment" is `finishing`: it's said whether or
     * not AI agents may speak.
     */
    async speak(input: {
      device: string;
      text: string;
      language: SpeechLanguage;
      actor: Actor;
      finishing?: true;
      // A request's reply that only confirms what worked: the success
      // chime, or the words where it can't play.
      confirmation?: boolean;
      beforeTelling?: () => void;
      onSynthesisStarted?: () => void;
      onDelivery?: (fetched: boolean) => void;
      signal?: AbortSignal;
    }) {
      const how = {
        finishing: input.finishing === true,
        // A finishing reply can queue behind an acknowledgement whose
        // listening run hasn't ended yet. Give it time for that run too.
        dispatchWithinMs: input.finishing
          ? listeningRunMs + dispatchWithinMs
          : dispatchWithinMs,
        onFetched: async (url: string) => {
          try {
            await options.devices.announce(
              input.device,
              url,
              input.actor,
              true,
            );
          } catch (error) {
            options.log(
              `Speech couldn't confirm the speaker's fetch: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        },
        tell: (url: string) =>
          options.devices.announce(input.device, url, input.actor),
      };
      const chime = input.confirmation ? options.chime : undefined;
      const announcement = chime
        ? await prepare(input, { ...how, sound: chime }).catch(
            (error: unknown) => {
              if (input.signal?.aborted) throw error;
              return prepare(input, how);
            },
          )
        : await prepare(input, how);
      const onDelivery = input.onDelivery;
      if (onDelivery) {
        void announcement.delivery
          .then((outcome) => {
            if (outcome !== "withdrawn") onDelivery(outcome === "fetched");
          })
          .catch((error: unknown) => {
            options.log(
              `Speech couldn't record delivery: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
      }
      return { encoded: announcement.encoded };
    },

    /**
     * Makes `text` ready as a request's reply on the smart speaker that
     * heard it, after what the speaker has still to say, whether or not AI
     * agents may speak, since it finishes someone's request: resolves with
     * its address once there is sound to play and its turn has come, for the
     * speaker's run to hand on. Throws as `speak` does.
     */
    async reply(input: {
      device: string;
      text: string;
      language: SpeechLanguage;
      // Words that only confirm an action that worked: the success chime
      // plays in their place, or they're said where it can't.
      confirmation?: boolean;
      signal?: AbortSignal;
      onPlayback?: (finished: boolean) => void;
    }): Promise<string> {
      let told = "";
      const tell = async (url: string) => {
        input.signal?.throwIfAborted();
        told = url;
      };
      const how = {
        finishing: true,
        tell,
        playbackGraceMs: replyPlaybackGraceMs,
      };
      const chime = input.confirmation ? options.chime : undefined;
      const announcement = chime
        ? await prepare(input, { ...how, sound: chime }).catch(
            (error: unknown) => {
              if (input.signal?.aborted) throw error;
              return prepare(input, how);
            },
          )
        : await prepare(input, how);
      const onPlayback = input.onPlayback;
      if (onPlayback) {
        void announcement.playback.then((outcome) => {
          if (outcome !== "withdrawn") onPlayback(outcome === "finished");
        });
      }
      return told;
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

import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { BlockList, isIPv4 } from "node:net";

import { createFlacEncoder } from "./flac.js";
import type { SpeechAudio } from "./wyoming.js";

// Announcements as smart speakers fetch them. A speaker plays sound from an
// address it's given, and the Voice PE takes plain HTTP only, so the core
// serves each announcement on a port of its own, on the home's network:
// a one-off address with 160 random bits in it, fetched once, gone a minute
// after it's made, from memory only. The address is the gate, as nothing
// that fetches it can sign in; the port answers only the home's own network
// and nothing but these addresses. The sound streams as it is spoken, so a
// speaker starts after the first sentence, not the last.

/** Sources on the home's network: private, link-local and loopback ranges. */
const homeNetwork = new BlockList();
for (const [network, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["169.254.0.0", 16],
  ["127.0.0.0", 8],
] as const) {
  homeNetwork.addSubnet(network, prefix, "ipv4");
}

function fromHomeNetwork(address: string | undefined) {
  if (!address) return false;
  const ipv4 = address.startsWith("::ffff:") ? address.slice(7) : address;
  return isIPv4(ipv4) && homeNetwork.check(ipv4, "ipv4");
}

/** How long an address waits for its speaker. */
export const announcementKeptMs = 60_000;
/** At most this many announcements at once in the whole home. */
export const maxAnnouncements = 8;
/** The most sound one announcement holds, in bytes (minutes of speech). */
const maxAnnouncementBytes = 4 * 1024 * 1024;

type Announcement = {
  device: string;
  path: string;
  chunks: Uint8Array[];
  bytes: number;
  samples: number;
  rate: number;
  done: boolean;
  fetchedAt: number | null;
  listeners: Set<() => void>;
  stop: AbortController;
  expiry: NodeJS.Timeout;
  release: NodeJS.Timeout | null;
};

export class AnnouncementRefused extends Error {
  constructor(readonly reason: "busy" | "full") {
    super(reason === "busy" ? "That speaker is busy" : "Too many announcements at once");
  }
}

export function createAnnouncements(options: {
  host: string;
  port: number;
  log: (message: string) => void;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const byPath = new Map<string, Announcement>();
  // A device's announcement, from its making until it has played: one at a
  // time, as a second one cuts the first short on the speaker.
  const byDevice = new Map<string, Announcement>();
  const server = createServer({ headersTimeout: 5_000, requestTimeout: 10_000 }, serve);
  server.maxConnections = 2 * maxAnnouncements;
  server.keepAliveTimeout = 1_000;

  function end(announcement: Announcement) {
    clearTimeout(announcement.expiry);
    if (announcement.release) clearTimeout(announcement.release);
    announcement.stop.abort();
    byPath.delete(announcement.path);
    if (byDevice.get(announcement.device) === announcement) {
      byDevice.delete(announcement.device);
    }
    announcement.chunks = [];
    for (const listener of announcement.listeners) listener();
    announcement.listeners.clear();
  }

  // Once fetched, it holds its speaker until the sound has had time to play.
  function releaseAfterPlaying(announcement: Announcement) {
    if (!announcement.done || announcement.fetchedAt === null) return;
    if (announcement.release) return;
    const playedMs = (announcement.samples / announcement.rate) * 1_000;
    const left = announcement.fetchedAt + playedMs + 1_000 - now();
    announcement.release = setTimeout(() => end(announcement), Math.max(0, left));
  }

  function notFound(response: ServerResponse) {
    response.writeHead(404, { "content-length": "0" }).end();
  }

  function serve(request: IncomingMessage, response: ServerResponse) {
    const path = (request.url ?? "").split("?")[0]!;
    const announcement = byPath.get(path);
    if (
      request.method !== "GET" ||
      !fromHomeNetwork(request.socket.remoteAddress) ||
      !announcement ||
      announcement.fetchedAt !== null
    ) {
      notFound(response);
      return;
    }
    announcement.fetchedAt = now();
    byPath.delete(path);
    response.writeHead(200, {
      "content-type": "audio/flac",
      "cache-control": "no-store",
    });
    let sent = 0;
    const flush = () => {
      while (sent < announcement.chunks.length) {
        response.write(announcement.chunks[sent++]);
      }
      if (announcement.done || announcement.stop.signal.aborted) {
        announcement.listeners.delete(flush);
        response.end();
      }
    };
    announcement.listeners.add(flush);
    response.on("close", () => announcement.listeners.delete(flush));
    flush();
    releaseAfterPlaying(announcement);
  }

  return {
    /**
     * Makes an announcement for a device from speech as it comes: its
     * address straight away, the sound as `speech` yields it. Refused while
     * the device has one that hasn't played yet, or the home has too many.
     */
    create(
      device: string,
      host: string,
      publishedPort: number,
      speech: (signal: AbortSignal) => AsyncIterable<SpeechAudio>,
    ) {
      if (byDevice.has(device)) throw new AnnouncementRefused("busy");
      if (byDevice.size >= maxAnnouncements) throw new AnnouncementRefused("full");
      const path = `/a/${randomBytes(20).toString("base64url")}.flac`;
      const announcement: Announcement = {
        device,
        path,
        chunks: [],
        bytes: 0,
        samples: 0,
        rate: 0,
        done: false,
        fetchedAt: null,
        listeners: new Set(),
        stop: new AbortController(),
        expiry: setTimeout(() => {
          if (announcement.fetchedAt === null) end(announcement);
        }, announcementKeptMs),
        release: null,
      };
      byPath.set(path, announcement);
      byDevice.set(device, announcement);
      const append = (bytes: Uint8Array) => {
        if (bytes.length === 0) return;
        announcement.bytes += bytes.length;
        if (announcement.bytes > maxAnnouncementBytes) {
          throw new Error("The announcement is too long");
        }
        announcement.chunks.push(bytes);
        for (const listener of [...announcement.listeners]) listener();
      };
      const spoken = (async () => {
        let encoder: ReturnType<typeof createFlacEncoder> | null = null;
        try {
          for await (const audio of speech(announcement.stop.signal)) {
            encoder ??= createFlacEncoder(audio.rate);
            announcement.rate = audio.rate;
            announcement.samples += audio.samples.length;
            append(encoder.push(audio.samples));
          }
          if (!encoder) throw new Error("The speech had no sound");
          append(encoder.end());
          announcement.done = true;
          for (const listener of [...announcement.listeners]) listener();
          releaseAfterPlaying(announcement);
          return true;
        } catch (error) {
          if (!announcement.stop.signal.aborted) {
            options.log(
              `An announcement's speech failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          end(announcement);
          return false;
        }
      })();
      return {
        url: `http://${host}:${publishedPort}${path}`,
        /** Whether all of it was spoken. */
        spoken,
        /** Withdraws it, as when its speaker couldn't be told. */
        withdraw: () => end(announcement),
        /** Whether its speaker has fetched it. */
        fetched: () => announcement.fetchedAt !== null,
      };
    },

    /** Whether a device has an announcement that hasn't played yet. */
    busy(device: string) {
      return byDevice.has(device);
    },

    async start() {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.port, options.host, () => {
          server.off("error", reject);
          resolve();
        });
      });
    },

    async stop() {
      for (const announcement of [...byDevice.values()]) end(announcement);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },

    /** The port it listens on, as tests ask for port 0. */
    port() {
      const address = server.address();
      return address && typeof address === "object" ? address.port : null;
    },
  };
}

export type Announcements = ReturnType<typeof createAnnouncements>;

import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { BlockList, isIPv4, type Socket } from "node:net";

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

/** The IPv4 subnet of the host interface used to reach speakers. */
export function speakerNetwork(host: string, cidr: string) {
  const [subnet, length] = cidr.split("/");
  const prefix = Number(length);
  if (
    !subnet ||
    !isIPv4(subnet) ||
    !isIPv4(host) ||
    !Number.isInteger(prefix) ||
    prefix < 1 ||
    prefix > 32
  )
    return null;
  const sources = new BlockList();
  sources.addSubnet(subnet, prefix, "ipv4");
  return sources.check(host, "ipv4") ? { host, sources } : null;
}

function ipv4Of(address: string | undefined) {
  const ipv4 = address?.replace(/^::ffff:/, "");
  return ipv4 && isIPv4(ipv4) ? ipv4 : null;
}

/** How long an address waits for its speaker. */
export const announcementKeptMs = 60_000;
/** At most this many announcements at once in the whole home. */
export const maxAnnouncements = 8;
/** The most sound one announcement holds, in bytes (minutes of speech). */
const maxAnnouncementBytes = 4 * 1024 * 1024;
const pendingDeadlineMs = 5_000;
const maxPending = 2 * maxAnnouncements;
const maxPendingPerSource = 2;
const streamIdleMs = 35_000;

type Announcement = {
  device: string;
  path: string;
  chunks: Uint8Array[];
  bytes: number;
  samples: number;
  rate: number;
  done: boolean;
  fetched: boolean;
  sources: BlockList;
  listeners: Set<() => void>;
  stop: AbortController;
  expiry: NodeJS.Timeout;
  release: NodeJS.Timeout | null;
};

export class AnnouncementRefused extends Error {
  constructor(readonly reason: "busy" | "full") {
    super(
      reason === "busy"
        ? "That speaker is busy"
        : "Too many announcements at once",
    );
  }
}

export function createAnnouncements(options: {
  host: string;
  port: number;
  log: (message: string) => void;
}) {
  const byPath = new Map<string, Announcement>();
  // A device's announcement, from its making until it has played: one at a
  // time, as a second one cuts the first short on the speaker.
  const byDevice = new Map<string, Announcement>();
  const server = createServer(
    { headersTimeout: 5_000, requestTimeout: 10_000 },
    serve,
  );
  server.maxRequestsPerSocket = 1;

  // Pending headers and verified playback have separate limits. A new
  // arrival can replace an idle connection without displacing a stream.
  const pending = new Map<Socket, NodeJS.Timeout>();
  function removePending(socket: Socket) {
    clearTimeout(pending.get(socket));
    pending.delete(socket);
  }
  function dropPending(socket: Socket) {
    removePending(socket);
    socket.destroy();
  }
  server.on("connection", (socket) => {
    const sameSource = [...pending.keys()].filter(
      (peer) => peer.remoteAddress === socket.remoteAddress,
    );
    if (sameSource.length >= maxPendingPerSource) {
      dropPending(sameSource[0]!);
    }
    if (pending.size >= maxPending) dropPending(pending.keys().next().value!);
    pending.set(
      socket,
      setTimeout(() => dropPending(socket), pendingDeadlineMs),
    );
    socket.once("close", () => removePending(socket));
  });

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

  // The driver doesn't confirm playback. Allow a full clip's worth of time
  // after the response finishes, even if synthesis or the network was slow.
  function releaseAfterPlaying(announcement: Announcement) {
    const playedMs = (announcement.samples / announcement.rate) * 1_000;
    announcement.release = setTimeout(
      () => end(announcement),
      playedMs + 1_000,
    );
  }

  function notFound(response: ServerResponse) {
    response
      .writeHead(404, { "content-length": "0", connection: "close" })
      .end();
  }

  function serve(request: IncomingMessage, response: ServerResponse) {
    const path = (request.url ?? "").split("?")[0]!;
    const announcement = byPath.get(path);
    const source = ipv4Of(request.socket.remoteAddress);
    if (
      request.method !== "GET" ||
      !source ||
      !announcement?.sources.check(source, "ipv4")
    ) {
      notFound(response);
      return;
    }
    removePending(request.socket);
    announcement.fetched = true;
    clearTimeout(announcement.expiry);
    byPath.delete(path);
    response.writeHead(200, {
      "content-type": "audio/flac",
      "cache-control": "no-store",
      connection: "close",
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
    response.setTimeout(streamIdleMs, () => response.destroy());
    response.once("finish", () => {
      if (announcement.done && !announcement.stop.signal.aborted) {
        releaseAfterPlaying(announcement);
      }
    });
    response.once("close", () => {
      announcement.listeners.delete(flush);
      if (!response.writableFinished) end(announcement);
    });
    flush();
  }

  return {
    /**
     * Makes an announcement for a device from speech as it comes: its
     * address straight away, the sound as `speech` yields it. Refused while
     * the device has one that hasn't played yet, or the home has too many.
     */
    create(
      device: string,
      network: NonNullable<ReturnType<typeof speakerNetwork>>,
      publishedPort: number,
      speech: (signal: AbortSignal) => AsyncIterable<SpeechAudio>,
    ) {
      if (byDevice.has(device)) throw new AnnouncementRefused("busy");
      if (byDevice.size >= maxAnnouncements)
        throw new AnnouncementRefused("full");
      const path = `/a/${randomBytes(20).toString("base64url")}.flac`;
      const announcement: Announcement = {
        device,
        path,
        chunks: [],
        bytes: 0,
        samples: 0,
        rate: 0,
        done: false,
        fetched: false,
        sources: network.sources,
        listeners: new Set(),
        stop: new AbortController(),
        expiry: setTimeout(() => end(announcement), announcementKeptMs),
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
      const encoded = (async () => {
        let encoder: ReturnType<typeof createFlacEncoder> | null = null;
        try {
          for await (const audio of speech(announcement.stop.signal)) {
            if (announcement.stop.signal.aborted) return false;
            encoder ??= createFlacEncoder(audio.rate);
            announcement.rate = audio.rate;
            announcement.samples += audio.samples.length;
            append(encoder.push(audio.samples));
          }
          if (announcement.stop.signal.aborted) return false;
          if (!encoder || announcement.samples === 0) {
            throw new Error("The speech had no sound");
          }
          append(encoder.end());
          announcement.done = true;
          for (const listener of [...announcement.listeners]) listener();
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
        url: `http://${network.host}:${publishedPort}${path}`,
        /** Whether FLAC encoding finished successfully. */
        encoded,
        /** Withdraws it, as when its speaker couldn't be told. */
        withdraw: () => end(announcement),
        /** Whether its speaker has fetched it. */
        fetched: () => announcement.fetched,
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
      for (const socket of pending.keys()) dropPending(socket);
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

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
// after its turn comes, from memory only. A speaker says one at a time, as a
// second cuts the first short on it, so the rest wait their turn in order. The address is the gate, as nothing
// that fetches it can sign in; the port answers only the home's own network
// and nothing but these addresses. The sound streams as it is spoken. A
// speaker starts once a lead of playable sound is ready, or all of it if
// that's shorter. The lead gives the synthesizer time to make the next
// sentence and reduces pauses during playback.

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

/**
 * How much sound is made before a speaker is told to play it, in ms. Speech
 * comes a sentence at a time, at two to three times the speed it's said on a
 * Pi 4, so this much ahead covers the next sentence's making.
 */
export const readyLeadMs = 2_000;

/** How long an address waits for its speaker. */
export const announcementKeptMs = 60_000;
/** At most this many announcements at once in the whole home. */
export const maxAnnouncements = 10;
/** At most this many for one speaker: the one it says and those waiting. */
export const maxPerSpeaker = 3;
/** The most sound one announcement holds, in bytes (minutes of speech). */
const maxAnnouncementBytes = 4 * 1024 * 1024;
const pendingDeadlineMs = 5_000;
const maxPending = 2 * maxAnnouncements;
const maxPendingPerSource = 2;
const streamIdleMs = 35_000;
const fetchNoticeMs = 250;

type Delivery = "fetched" | "failed" | "withdrawn";
type Playback = "finished" | "failed" | "withdrawn";

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
  // Set once its turn comes: until then it can't be fetched or expire.
  expiry: NodeJS.Timeout | null;
  release: NodeJS.Timeout | null;
  ended: boolean;
  ready: (ready: boolean) => void;
  turn: (now: boolean) => void;
  delivery: (outcome: Delivery) => void;
  onUnfetched?: () => void;
  onFetched?: () => Promise<void>;
  // A request's reply, said whether or not AI agents may speak.
  finishing: boolean;
  playbackGraceMs: number;
  complete(outcome: Playback): void;
};

export class AnnouncementRefused extends Error {
  constructor(readonly reason: "busy" | "full") {
    super(
      reason === "busy"
        ? "That speaker has too many waiting"
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
  // Each device's announcements, from their making until they have played,
  // in order: the first is the one whose turn it is.
  const byDevice = new Map<string, Announcement[]>();
  let count = 0;

  function takeTurn(announcement: Announcement) {
    announcement.expiry = setTimeout(() => {
      end(announcement, "failed");
      announcement.onUnfetched?.();
    }, announcementKeptMs);
    announcement.turn(true);
  }
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
    const source = ipv4Of(socket.remoteAddress);
    if (
      !source ||
      !Array.from(byPath.values()).some(
        (announcement) =>
          announcement.expiry && announcement.sources.check(source, "ipv4"),
      )
    ) {
      socket.destroy();
      return;
    }
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

  function end(announcement: Announcement, outcome: Playback = "withdrawn") {
    if (announcement.ended) return;
    announcement.ended = true;
    count--;
    if (announcement.expiry) clearTimeout(announcement.expiry);
    if (announcement.release) clearTimeout(announcement.release);
    announcement.stop.abort();
    byPath.delete(announcement.path);
    announcement.ready(false);
    announcement.turn(false);
    if (outcome !== "finished") announcement.delivery(outcome);
    announcement.complete(outcome);
    const queue = byDevice.get(announcement.device) ?? [];
    const at = queue.indexOf(announcement);
    if (at !== -1) queue.splice(at, 1);
    if (queue.length === 0) byDevice.delete(announcement.device);
    else if (at === 0) takeTurn(queue[0]!);
    announcement.chunks = [];
    for (const listener of announcement.listeners) listener();
    announcement.listeners.clear();
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
      !announcement?.expiry ||
      !announcement.sources.check(source, "ipv4")
    ) {
      notFound(response);
      return;
    }
    removePending(request.socket);
    clearTimeout(announcement.expiry);
    announcement.expiry = null;
    byPath.delete(path);
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
    response.setTimeout(streamIdleMs, () => response.destroy());
    response.once("close", () => {
      announcement.listeners.delete(flush);
      if (!response.writableFinished) end(announcement, "failed");
    });
    const startStream = () => {
      if (response.destroyed) return;
      if (announcement.ended) {
        notFound(response);
        return;
      }
      const startedAt = performance.now();
      response.once("finish", () => {
        if (!announcement.done || announcement.stop.signal.aborted) return;
        // Playback can run during synthesis. Leave time for the whole clip
        // and keep the speaker held until the stream has finished.
        const clipMs = (announcement.samples / announcement.rate) * 1_000;
        const remainingMs = Math.max(0, startedAt + clipMs - performance.now());
        announcement.release = setTimeout(
          () => end(announcement, "finished"),
          remainingMs + announcement.playbackGraceMs,
        );
      });
      response.writeHead(200, {
        "content-type": "audio/flac",
        "cache-control": "no-store",
        connection: "close",
      });
      announcement.listeners.add(flush);
      flush();
      announcement.fetched = true;
      announcement.delivery("fetched");
    };
    if (announcement.onFetched) {
      // Give the driver a chance to classify playback before audio arrives.
      // Audio still plays if the driver is slow or cannot take the notice.
      let timer: NodeJS.Timeout;
      const deadline = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, fetchNoticeMs);
      });
      void Promise.race([announcement.onFetched(), deadline]).then(() => {
        clearTimeout(timer);
        startStream();
      });
    } else {
      startStream();
    }
  }

  return {
    /**
     * Makes an announcement for a device from speech as it comes: its
     * address straight away, the sound as `speech` yields it, `ready` once
     * there is sound to play and `turn` once those before it on the device
     * have played. Refused while the device has too many waiting, or the
     * home has too many. Calls `onUnfetched` if the address expires, a
     * minute into its turn, without a fetch.
     */
    create(
      device: string,
      network: NonNullable<ReturnType<typeof speakerNetwork>>,
      publishedPort: number,
      speech: (signal: AbortSignal) => AsyncIterable<SpeechAudio>,
      onUnfetched?: () => void,
      onFetched?: (url: string) => Promise<void>,
      {
        finishing = false,
        playbackGraceMs = 1_000,
        readyWithinMs,
      }: {
        finishing?: boolean;
        playbackGraceMs?: number;
        // From then on, any playable sound is ready, short of the lead: a
        // reply that has to start before "One moment" is said.
        readyWithinMs?: number;
      } = {},
    ) {
      const queue = byDevice.get(device) ?? [];
      if (queue.length >= maxPerSpeaker) throw new AnnouncementRefused("busy");
      if (count >= maxAnnouncements) throw new AnnouncementRefused("full");
      const path = `/a/${randomBytes(20).toString("base64url")}.flac`;
      const url = `http://${network.host}:${publishedPort}${path}`;
      let sounded: (ready: boolean) => void = () => {};
      const ready = new Promise<boolean>((resolve) => (sounded = resolve));
      let turned: (now: boolean) => void = () => {};
      const turn = new Promise<boolean>((resolve) => (turned = resolve));
      let delivered: (outcome: Delivery) => void = () => {};
      const delivery = new Promise<Delivery>(
        (resolve) => (delivered = resolve),
      );
      let complete!: (outcome: Playback) => void;
      const playback = new Promise<Playback>((resolve) => (complete = resolve));
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
        expiry: null,
        release: null,
        ended: false,
        ready: sounded,
        turn: turned,
        delivery: delivered,
        onUnfetched,
        onFetched: onFetched && (() => onFetched(url)),
        finishing,
        playbackGraceMs,
        complete,
      };
      byPath.set(path, announcement);
      queue.push(announcement);
      byDevice.set(device, queue);
      count++;
      if (queue.length === 1) takeTurn(announcement);
      const append = (bytes: Uint8Array) => {
        if (bytes.length === 0) return;
        announcement.bytes += bytes.length;
        if (announcement.bytes > maxAnnouncementBytes) {
          throw new Error("The announcement is too long");
        }
        announcement.chunks.push(bytes);
        for (const listener of [...announcement.listeners]) listener();
      };
      let encoder: ReturnType<typeof createFlacEncoder> | null = null;
      let isDue = false;
      const due =
        readyWithinMs === undefined
          ? undefined
          : setTimeout(() => {
              isDue = true;
              if (encoder && encoder.encodedSamples() > 0) sounded(true);
            }, readyWithinMs);
      due?.unref();
      void ready.then(() => clearTimeout(due));
      const encoded = (async () => {
        try {
          for await (const audio of speech(announcement.stop.signal)) {
            if (announcement.stop.signal.aborted) return false;
            if (!encoder) {
              encoder = createFlacEncoder(audio.rate);
              announcement.rate = audio.rate;
            }
            announcement.samples += audio.samples.length;
            append(encoder.push(audio.samples));
            const lead = (announcement.rate * readyLeadMs) / 1000;
            const made = encoder.encodedSamples();
            if (made >= lead || (isDue && made > 0)) sounded(true);
          }
          if (announcement.stop.signal.aborted) return false;
          if (!encoder || announcement.samples === 0) {
            throw new Error("The speech had no sound");
          }
          append(encoder.end());
          sounded(true);
          announcement.done = true;
          for (const listener of [...announcement.listeners]) listener();
          return true;
        } catch (error) {
          if (!announcement.stop.signal.aborted) {
            options.log(
              `An announcement's speech failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          end(announcement, "failed");
          return false;
        }
      })();
      return {
        url,
        dispatchUrl: () =>
          announcement.ended || announcement.fetched || !announcement.expiry
            ? null
            : url,
        /** Whether FLAC encoding finished successfully. */
        encoded,
        /**
         * Whether there is sound to play: true once `readyLeadMs` of it, or
         * all of it, is encoded, false if the speech failed before then.
         */
        ready,
        /**
         * Whether its turn on the device came: true once those before it
         * have played, false if it ended first.
         */
        turn,
        delivery,
        playback,
        /** Withdraws it, as when its speaker couldn't be told. */
        withdraw: () => end(announcement),
        /** Whether its speaker has fetched it. */
        fetched: () => announcement.fetched,
      };
    },

    /**
     * Withdraws every announcement no speaker has fetched yet, those waiting
     * their turn too, as when AI agents may no longer speak: what a speaker
     * already plays goes on, and so do requests' replies, which finish what
     * someone asked.
     */
    withdrawUnfetched() {
      for (const queue of [...byDevice.values()]) {
        // The last first, so none takes its turn on the way out.
        for (const announcement of [...queue].reverse()) {
          if (!announcement.fetched && !announcement.finishing) {
            end(announcement, "failed");
          }
        }
      }
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
      for (const queue of [...byDevice.values()]) {
        // The last first, so none takes its turn on the way out.
        for (const announcement of [...queue].reverse()) end(announcement);
      }
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

import { request } from "node:http";
import { createConnection } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AnnouncementRefused,
  createAnnouncements,
  speakerNetwork,
  type Announcements,
} from "../src/speech/announcements.js";
import type { SpeechAudio } from "../src/speech/wyoming.js";

// Announcements as smart speakers fetch them: one-off addresses on a port of
// their own, each fetched once, gone a minute into its turn, streamed as the
// speech comes, one at a time for each speaker with the rest waiting.

let announcements: Announcements | undefined;
const logged: string[] = [];

afterEach(async () => {
  await announcements?.stop();
  announcements = undefined;
  logged.length = 0;
});

async function started() {
  announcements = createAnnouncements({
    host: "127.0.0.1",
    port: 0,
    log: (message) => logged.push(message),
  });
  await announcements.start();
  return announcements;
}

/** Speech that yields `pieces` of samples, waiting for `gate` before the last. */
function speech(pieces: number[], gate?: Promise<void>) {
  return async function* (): AsyncGenerator<SpeechAudio> {
    for (const [i, length] of pieces.entries()) {
      if (gate && i === pieces.length - 1) await gate;
      yield { rate: 22_050, samples: new Int16Array(length).fill(i * 100 + 1) };
    }
  };
}

function fetch(url: string, method = "GET", onBytes?: (bytes: number) => void) {
  return new Promise<{
    status: number;
    type?: string;
    cache?: string;
    body: Buffer;
  }>((resolve, reject) => {
    const req = request(url, { method }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        chunks.push(chunk);
        bytes += chunk.length;
        onBytes?.(bytes);
      });
      response.on("error", reject);
      response.on("end", () =>
        resolve({
          status: response.statusCode ?? 0,
          type: response.headers["content-type"],
          cache: response.headers["cache-control"],
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.setTimeout(2_000, () =>
      req.destroy(new Error("No announcement audio arrived")),
    );
    req.on("error", reject);
    req.end();
  });
}

const network = speakerNetwork("127.0.0.1", "127.0.0.1/32")!;

const local = (url: string, port: number) =>
  url.replace(/^http:\/\/[^/]+/, `http://127.0.0.1:${port}`);

describe("createAnnouncements", () => {
  it("uses the manager's interface prefix to identify the home network", () => {
    const subnet = speakerNetwork("192.168.7.222", "192.168.7.222/27");
    expect(subnet?.sources.check("192.168.7.201", "ipv4")).toBe(true);
    expect(subnet?.sources.check("192.168.7.180", "ipv4")).toBe(false);
    expect(subnet?.sources.check("10.0.0.1", "ipv4")).toBe(false);
    expect(speakerNetwork("192.168.7.222", "0.0.0.0/0")).toBeNull();
  });

  it("serves an announcement once, as FLAC at a one-off address, and nothing else", async () => {
    const served = await started();
    const port = served.port()!;
    const made = served.create(
      "speaker",
      network,
      4180,
      speech([5_000, 3_000]),
    );
    expect(made.url).toMatch(
      /^http:\/\/127\.0\.0\.1:4180\/a\/[A-Za-z0-9_-]{27}\.flac$/,
    );
    expect(await made.encoded).toBe(true);

    const first = await fetch(local(made.url, port));
    expect(first.status).toBe(200);
    expect(first.type).toBe("audio/flac");
    expect(first.cache).toBe("no-store");
    expect(first.body.subarray(0, 4).toString()).toBe("fLaC");
    expect(made.fetched()).toBe(true);

    expect((await fetch(local(made.url, port))).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/a/guess.flac`)).status).toBe(
      404,
    );
    expect((await fetch(`http://127.0.0.1:${port}/`)).status).toBe(404);
  });

  it("answers only GET", async () => {
    const served = await started();
    const made = served.create("speaker", network, 4180, speech([100]));
    await made.encoded;
    expect((await fetch(local(made.url, served.port()!), "HEAD")).status).toBe(
      404,
    );
    // A refused request doesn't use it up.
    expect((await fetch(local(made.url, served.port()!))).status).toBe(200);
  });

  it("streams the sound as it's spoken, so a speaker starts before the end", async () => {
    const served = await started();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const made = served.create(
      "speaker",
      network,
      4180,
      speech([4_096, 4_096, 100], gate),
    );
    let audioArrived!: () => void;
    const firstAudio = new Promise<void>((resolve) => (audioArrived = resolve));
    const response = fetch(local(made.url, served.port()!), "GET", (bytes) => {
      if (bytes > 42) audioArrived();
    });
    try {
      await Promise.race([firstAudio, response]);
    } finally {
      release();
    }
    const { body } = await response;
    expect(await made.encoded).toBe(true);
    expect(body.subarray(0, 4).toString()).toBe("fLaC");
    expect(body.length).toBeGreaterThan(42);
  });

  it("has the rest wait their turn on a speaker, in order, until what's before them has played", async () => {
    const served = await started();
    // A tenth of a second of sound.
    const first = served.create("speaker", network, 4180, speech([2_205]));
    const second = served.create("speaker", network, 4180, speech([10]));
    const third = served.create("speaker", network, 4180, speech([10]));
    expect(() => served.create("speaker", network, 4180, speech([10]))).toThrow(
      new AnnouncementRefused("busy"),
    );
    // Another speaker isn't held.
    const other = served.create("other", network, 4180, speech([10]));
    expect(await other.turn).toBe(true);
    other.withdraw();
    expect(await first.turn).toBe(true);
    let secondsTurn = false;
    void second.turn.then(() => (secondsTurn = true));
    await second.encoded;
    // Made already, but not to be fetched before its turn.
    expect((await fetch(local(second.url, served.port()!))).status).toBe(404);
    await first.encoded;
    expect((await fetch(local(first.url, served.port()!))).status).toBe(200);
    expect(secondsTurn).toBe(false);
    // Once the first has had time to play, and a second more, it's the next's.
    expect(await second.turn).toBe(true);
    expect((await fetch(local(second.url, served.port()!))).status).toBe(200);
    expect(served.busy("speaker")).toBe(true);
    third.withdraw();
    expect(await third.turn).toBe(false);
  });

  it("gives the next its turn when the one before ends unplayed", async () => {
    const served = await started();
    const first = served.create("speaker", network, 4180, speech([10]));
    const second = served.create("speaker", network, 4180, speech([10]));
    const third = served.create("speaker", network, 4180, speech([10]));
    // One waiting goes: the order of the rest stays.
    second.withdraw();
    expect(await second.turn).toBe(false);
    first.withdraw();
    expect(await third.turn).toBe(true);
    expect((await fetch(local(third.url, served.port()!))).status).toBe(200);
  });

  it("keeps the speaker busy for the clip after a delayed response ends", async () => {
    const served = await started();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const made = served.create(
      "speaker",
      network,
      4180,
      speech([4_096, 100], gate),
    );
    let delayed = false;
    const body = fetch(local(made.url, served.port()!), "GET", () => {
      if (delayed) return;
      delayed = true;
      vi.advanceTimersByTime(5_000);
      release();
    });
    try {
      expect((await body).status).toBe(200);
      vi.advanceTimersByTime(1_100);
      expect(served.busy("speaker")).toBe(true);
      vi.advanceTimersByTime(100);
      expect(served.busy("speaker")).toBe(false);
    } finally {
      release();
      vi.useRealTimers();
    }
  });

  it("refuses a valid URL outside the selected interface's prefix", async () => {
    const served = await started();
    const elsewhere = speakerNetwork("127.0.0.2", "127.0.0.2/32")!;
    const made = served.create("speaker", elsewhere, 4180, speech([100]));
    expect((await fetch(local(made.url, served.port()!))).status).toBe(404);
    expect(made.fetched()).toBe(false);
  });

  it("accepts a speaker while other connections from its address are idle", async () => {
    const served = await started();
    const port = served.port()!;
    const idle = [];
    try {
      for (let i = 0; i < 20; i++) {
        const socket = createConnection(port, "127.0.0.1");
        idle.push(socket);
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve);
          socket.once("error", reject);
        });
      }
      const made = served.create("speaker", network, 4180, speech([100]));
      expect((await fetch(local(made.url, port))).status).toBe(200);
    } finally {
      for (const socket of idle) socket.destroy();
    }
  });

  it("lets an address go a minute into its turn, unfetched", async () => {
    const served = await started();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const made = served.create("speaker", network, 4180, speech([10]));
    await made.encoded;
    vi.advanceTimersByTime(59_000);
    expect(served.busy("speaker")).toBe(true);
    vi.advanceTimersByTime(1_001);
    vi.useRealTimers();
    expect(served.busy("speaker")).toBe(false);
    expect((await fetch(local(made.url, served.port()!))).status).toBe(404);
  });

  it("starts a waiting address's minute only at its turn", async () => {
    const served = await started();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const unfetched: string[] = [];
    const first = served.create("speaker", network, 4180, speech([10]), () =>
      unfetched.push("first"),
    );
    const second = served.create("speaker", network, 4180, speech([10]), () =>
      unfetched.push("second"),
    );
    await Promise.all([first.encoded, second.encoded]);
    vi.advanceTimersByTime(60_001);
    expect(unfetched).toEqual(["first"]);
    expect(await second.turn).toBe(true);
    vi.advanceTimersByTime(59_000);
    expect(served.busy("speaker")).toBe(true);
    vi.advanceTimersByTime(1_001);
    vi.useRealTimers();
    expect(unfetched).toEqual(["first", "second"]);
    expect(served.busy("speaker")).toBe(false);
  });

  it("withdraws an announcement whose speech fails, and logs why", async () => {
    const served = await started();
    const made = served.create("speaker", network, 4180, async function* () {
      yield { rate: 22_050, samples: new Int16Array(10) };
      throw new Error("Piper went away");
    });
    expect(await made.encoded).toBe(false);
    expect(served.busy("speaker")).toBe(false);
    expect(logged).toEqual([
      "An announcement's speech failed: Piper went away",
    ]);
  });

  it("takes at most eight at once in the home, those waiting too", async () => {
    const served = await started();
    for (let i = 0; i < 6; i++) {
      served.create(`speaker-${i}`, network, 4180, speech([10]));
    }
    served.create("speaker-0", network, 4180, speech([10]));
    served.create("speaker-0", network, 4180, speech([10]));
    expect(() =>
      served.create("speaker-8", network, 4180, speech([10])),
    ).toThrow(new AnnouncementRefused("full"));
  });
});

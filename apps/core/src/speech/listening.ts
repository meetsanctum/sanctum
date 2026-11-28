import { randomBytes } from "node:crypto";

import {
  ActionError,
  listenCloseSchema,
  listenMaxMs,
  listenOpenSchema,
  listenQuietMs,
  listenRate,
  listenReadSchema,
  listenReadWaitMs,
  listenSendSchema,
  maxListenChunkBytes,
  type ListenEnd,
  type ListenError,
  type ListenOpened,
  type ListenRefusal,
  type ListenStep,
} from "@meetsanctum/app-sdk";

// Smart speakers' runs (listening.ts in the app SDK): a driver opens one as
// its speaker hears its wake word, sends the microphone's sound, and reads
// the steps to show. The core takes a run only when something hears it, the
// hearer, and hands the hearer the sound as it comes; nothing else ever
// gets it, and it lives in memory for the run alone. The hearer tells the
// run what to show: listening has stopped, what was heard, a reply, an
// error, done.
//
// The run's own limits hold whatever the hearer does: one run per speaker
// (a newer one ends the older), a few at once in the home, `listenMaxMs` of
// sound, `listenQuietMs` without any, and a run that never finishes ends
// after `listeningRunMs`. Each run keeps its moments: when its wake word was
// heard, its first sound, when listening stopped, when recognition finished,
// when its reply was ready and when that finished playing, which only its
// driver can say.

/** The most runs at once in the home. */
export const runsAtOnce = 4;
/** The longest a run lasts, its reply included, before it ends as failed. */
export const listeningRunMs = 60_000;
/** How long a finished run's steps stay to be read. */
const keptMs = 10_000;
/** The most finished runs kept for their drivers to read. */
const keptRuns = 16;
const maxSoundBytes = (listenRate * 2 * listenMaxMs) / 1000;

/** When each part of a run happened, in ms since the epoch, or null while it hasn't. */
export type RunMoments = {
  heard: number;
  firstSound: number | null;
  stoppedListening: number | null;
  /** When speech recognition gave its words, or found none it knows. */
  heardWords: number | null;
  replyReady: number | null;
  finishedPlaying: number | null;
};

/** A run as its hearer has it. */
export type HeardRun = {
  id: string;
  device: string;
  /** The driver that opened it. */
  driver: string;
  wakeWord: string | null;
  /** The sound as it comes, ending once listening stops. */
  sound: AsyncIterable<Buffer>;
  /** Stops listening: the speaker stops sending, and `sound` ends. */
  stopListening(): void;
  /** Notes when speech recognition answered, with words or none it knows. */
  recognised(): void;
  heard(text: string): void;
  /** A reply to play from an address the core serves. */
  reply(url: string, text: string): void;
  /** Ends the run in an error. */
  fail(error: ListenError): void;
  /** Ends the run. */
  done(): void;
  /** Aborts when the run ends. */
  signal: AbortSignal;
  readonly moments: Readonly<RunMoments>;
  /** How the driver ended it, once it did. */
  readonly ended: ListenEnd | null;
};

/** What hears the home's runs; without one, every run is refused `off`. */
export type Hearer = (run: HeardRun) => void | Promise<void>;

type Run = Omit<HeardRun, "moments" | "ended"> & {
  moments: RunMoments;
  ended: ListenEnd | null;
  steps: ListenStep[];
  finished: boolean;
  readers: Set<() => void>;
  push(chunk: Buffer): void;
  endSound(discard?: boolean): void;
  soundBytes: number;
  quiet?: NodeJS.Timeout;
  limit: NodeJS.Timeout;
  controller: AbortController;
};

// Sound as an async iterable that ends when told.
function soundQueue() {
  const chunks: Buffer[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  return {
    push(chunk: Buffer) {
      if (ended) return;
      chunks.push(chunk);
      wake?.();
    },
    end(discard = false) {
      if (discard) chunks.length = 0;
      ended = true;
      wake?.();
    },
    async *iterate() {
      for (;;) {
        while (chunks.length > 0) yield chunks.shift()!;
        if (ended) return;
        await new Promise<void>((resolve) => (wake = resolve));
        wake = null;
      }
    },
  };
}

export function createListening(options: {
  // The core's id for a driver's device, by its key.
  idFor: (driver: string, key: string) => string | null;
  // Whether a device's `audio` part says it listens.
  listens: (device: string) => boolean;
  // What hears a device's run, or why it's refused; none is `off`.
  hearer: (device: string) => Hearer | ListenRefusal | null;
  // A run the core refused on its own account, not the hearer's.
  refused?: (device: string, refusal: ListenRefusal) => void;
  now?: () => number;
  log: (message: string) => void;
}) {
  const now = options.now ?? Date.now;
  const runs = new Map<string, Run>();
  const bySpeaker = new Map<string, Run>();
  const expiry = new Map<string, NodeJS.Timeout>();
  let closed = false;

  function tell(run: Run, step: ListenStep) {
    if (run.finished) return;
    run.steps.push(step);
    for (const read of run.readers) read();
    if (step.step === "done") finish(run);
  }

  function forget(id: string) {
    clearTimeout(expiry.get(id));
    expiry.delete(id);
    runs.delete(id);
  }

  // A run whose last step is told: only its steps stay a while to be read.
  function finish(run: Run) {
    run.finished = true;
    run.endSound(true);
    clearTimeout(run.quiet);
    clearTimeout(run.limit);
    if (bySpeaker.get(run.device) === run) bySpeaker.delete(run.device);
    expiry.set(run.id, setTimeout(() => forget(run.id), keptMs).unref());
    if (expiry.size > keptRuns) {
      const oldest = expiry.keys().next().value!;
      forget(oldest);
    }
    run.controller.abort();
  }

  function stopListening(run: Run) {
    if (run.moments.stoppedListening !== null || run.finished) return;
    run.moments.stoppedListening = now();
    clearTimeout(run.quiet);
    run.endSound();
    tell(run, { step: "stopped" });
  }

  // Ends a run on the core's side: listening stops, then the error and done.
  function fail(run: Run, error: ListenError) {
    if (run.finished) return;
    stopListening(run);
    tell(run, { step: "error", error });
    tell(run, { step: "done" });
  }

  function cancelRuns() {
    for (const run of bySpeaker.values()) fail(run, "failed");
  }

  function quietFor(run: Run) {
    clearTimeout(run.quiet);
    run.quiet = setTimeout(() => fail(run, "nothing-heard"), listenQuietMs);
    run.quiet.unref();
  }

  // A driver's own run, as it names it: another app's is no run at all.
  function runOf(driver: string, id: string) {
    const run = runs.get(id);
    return run && run.driver === driver ? run : null;
  }

  return {
    open(driver: string, input: unknown): ListenOpened {
      const parsed = listenOpenSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(`${driver} opened a run the core cannot take`);
      }
      const device = options.idFor(driver, parsed.data.key);
      if (!device) throw new ActionError("not_found");
      if (closed) return { accepted: false, refusal: "unavailable" };
      const refuse = (refusal: ListenRefusal): ListenOpened => {
        options.refused?.(device, refusal);
        return { accepted: false, refusal };
      };
      // A request can arrive before an updated device registration does.
      if (!options.listens(device)) return refuse("unavailable");
      const older = bySpeaker.get(device);
      if (!older && bySpeaker.size >= runsAtOnce) return refuse("limited");
      const hearer = options.hearer(device) ?? "off";
      if (typeof hearer === "string")
        return { accepted: false, refusal: hearer };
      // A speaker runs one request at a time: a newer one ends the older.
      if (older) fail(older, "failed");

      const id = randomBytes(12).toString("base64url");
      const sound = soundQueue();
      const controller = new AbortController();
      const run: Run = {
        id,
        device,
        driver,
        wakeWord: parsed.data.wakeWord,
        sound: { [Symbol.asyncIterator]: () => sound.iterate() },
        steps: [],
        finished: false,
        readers: new Set(),
        soundBytes: 0,
        controller,
        signal: controller.signal,
        ended: null,
        moments: {
          heard: now(),
          firstSound: null,
          stoppedListening: null,
          heardWords: null,
          replyReady: null,
          finishedPlaying: null,
        },
        push: (chunk) => sound.push(chunk),
        endSound: sound.end,
        stopListening: () => stopListening(run),
        recognised() {
          run.moments.heardWords ??= now();
        },
        heard: (text) => tell(run, { step: "heard", text }),
        reply(url, text) {
          if (run.finished) return;
          run.moments.replyReady ??= now();
          tell(run, { step: "reply", url, text });
        },
        fail: (error) => fail(run, error),
        done() {
          if (run.finished) return;
          run.ended = "done";
          stopListening(run);
          tell(run, { step: "done" });
        },
        limit: setTimeout(() => fail(run, "failed"), listeningRunMs),
      };
      run.limit.unref();
      runs.set(id, run);
      bySpeaker.set(device, run);
      quietFor(run);
      const hearingFailed = (error: unknown) => {
        if (run.finished) return;
        options.log(
          `listening: a run couldn't be heard (${error instanceof Error ? error.message : String(error)})`,
        );
        fail(run, "failed");
      };
      try {
        void hearer(run)?.catch(hearingFailed);
      } catch (error) {
        hearingFailed(error);
      }
      return { accepted: true, run: id };
    },

    // The run's next sound. Sound after listening stopped is taken and
    // dropped, as the speaker sends a little more before it stops.
    send(driver: string, input: unknown) {
      const parsed = listenSendSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(`${driver} sent a run sound the core cannot take`);
      }
      const run = runOf(driver, parsed.data.run);
      if (!run || run.finished) throw new ActionError("not_found");
      const chunk = Buffer.from(parsed.data.audio, "base64");
      if (
        chunk.byteLength === 0 ||
        chunk.byteLength > maxListenChunkBytes ||
        chunk.byteLength % 2 !== 0
      ) {
        throw new Error(`${driver} sent sound that isn't 16-bit PCM`);
      }
      if (run.moments.stoppedListening !== null) return;
      const taken = chunk.subarray(0, maxSoundBytes - run.soundBytes);
      run.moments.firstSound ??= now();
      run.soundBytes += taken.byteLength;
      run.push(taken);
      if (run.soundBytes === maxSoundBytes) stopListening(run);
      else quietFor(run);
    },

    // The run's steps after the first `after`, waiting a moment for one.
    // A run that's gone is done.
    async read(driver: string, input: unknown): Promise<ListenStep[]> {
      const parsed = listenReadSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(`${driver} read a run the core cannot read`);
      }
      const run = runOf(driver, parsed.data.run);
      if (!run) return [{ step: "done" }];
      const { after } = parsed.data;
      if (run.steps.length <= after && !run.finished) {
        await new Promise<void>((resolve) => {
          const wake = () => {
            clearTimeout(timer);
            run.readers.delete(wake);
            resolve();
          };
          const timer = setTimeout(wake, listenReadWaitMs).unref();
          run.readers.add(wake);
        });
      }
      return run.steps.slice(after);
    },

    // The driver ends the run: its reply played, or the speaker, its
    // connection or the driver gave it up.
    close(driver: string, input: unknown) {
      const parsed = listenCloseSchema.safeParse(input);
      if (!parsed.success) {
        throw new Error(`${driver} closed a run the core cannot close`);
      }
      const run = runOf(driver, parsed.data.run);
      if (!run || run.finished) return;
      const { end } = parsed.data;
      run.ended = end;
      if (end === "played" && run.moments.replyReady !== null)
        run.moments.finishedPlaying = now();
      stopListening(run);
      tell(run, { step: "done" });
    },

    /** A driver stopped: its runs end. */
    driverStopped(driver: string) {
      for (const run of bySpeaker.values()) {
        if (run.driver === driver) fail(run, "failed");
      }
    },

    /** A device went: its run ends. */
    deviceGone(device: string) {
      const run = bySpeaker.get(device);
      if (run) fail(run, "failed");
    },

    cancelRuns,

    /** The core stops: runs end and no new one is taken. */
    stop() {
      closed = true;
      cancelRuns();
    },

    /** Final steps are no longer needed once the app host closes. */
    clearFinished() {
      for (const id of expiry.keys()) forget(id);
    },
  };
}

export type Listening = ReturnType<typeof createListening>;

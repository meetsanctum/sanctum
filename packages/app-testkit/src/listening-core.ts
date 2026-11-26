import {
  listenCloseSchema,
  listenOpenSchema,
  listenReadSchema,
  listenSendSchema,
  type ListenCalls,
  type ListenEnd,
  type ListenOpen,
  type ListenRefusal,
  type ListenStep,
} from "@meetsanctum/app-sdk";
import { z } from "zod";

// A fake core's side of listening (listening.ts in the app SDK): it takes or
// refuses a driver's runs, as a test says, keeps the sound each run sent,
// and hands the driver the steps a test pushes, checking every call with
// the core's own schemas.

export type FakeRun = {
  id: string;
  open: ListenOpen;
  /** The sound the driver sent, in order. */
  audio: Buffer;
  /** How the driver closed it, once it did. */
  end: ListenEnd | null;
  steps: ListenStep[];
};

export function createListeningCore(options: {
  // Whether a run is taken: a refusal turns it away.
  refuse: () => ListenRefusal | null;
  refuseCall: (error: Error) => never;
  beforeListenReply?: () => Promise<void>;
}) {
  const runs = new Map<string, FakeRun>();
  const waiting = new Map<string, Set<() => void>>();
  let next = 0;

  function parsed<T>(schema: z.ZodType<T>, input: unknown, what: string) {
    const result = schema.safeParse(input);
    if (!result.success) {
      options.refuseCall(
        new Error(`${what} refused: ${z.prettifyError(result.error)}`),
      );
    }
    return result.data!;
  }

  function runOf(id: string) {
    const run = runs.get(id);
    if (!run) options.refuseCall(new Error(`No run ${id}`));
    return run!;
  }

  /** Tells a run's driver a step, as the core would. */
  function step(id: string, step: ListenStep) {
    const run = runOf(id);
    if (run.steps.at(-1)?.step === "done") return;
    run.steps.push(step);
    const readers = waiting.get(id);
    waiting.delete(id);
    for (const wake of readers ?? []) wake();
  }

  const calls: ListenCalls = {
    async openListen(input) {
      const open = parsed(listenOpenSchema, input, "A run");
      const refusal = options.refuse();
      if (refusal) return { accepted: false, refusal };
      next += 1;
      const id = `run-test-${next}`;
      runs.set(id, { id, open, audio: Buffer.alloc(0), end: null, steps: [] });
      if (options.beforeListenReply) await options.beforeListenReply();
      return { accepted: true, run: id };
    },
    async sendListen(input) {
      const send = parsed(listenSendSchema, input, "A run's sound");
      const run = runOf(send.run);
      run.audio = Buffer.concat([run.audio, Buffer.from(send.audio, "base64")]);
    },
    async readListen(input) {
      const read = parsed(listenReadSchema, input, "A run's read");
      const run = runOf(read.run);
      if (run.steps.length <= read.after && run.steps.at(-1)?.step !== "done") {
        await new Promise<void>((resolve) => {
          const readers = waiting.get(run.id) ?? new Set<() => void>();
          readers.add(resolve);
          waiting.set(run.id, readers);
        });
      }
      return run.steps.slice(read.after);
    },
    async closeListen(input) {
      const close = parsed(listenCloseSchema, input, "A run's end");
      runOf(close.run).end = close.end;
      step(close.run, { step: "done" });
    },
  };

  return {
    calls,
    runs,
    /** The latest run the driver opened. */
    latest() {
      return [...runs.values()].at(-1) ?? null;
    },
    step,
  };
}

import {
  isActionError,
  type Actor,
  type CoreCalls,
} from "@meetsanctum/app-sdk";
import {
  appMessageSchema,
  createMessageReader,
  encodeMessage,
  failureOf,
  type AppMessage,
  type CallBody,
  type CoreMessage,
  type Outcome,
} from "@meetsanctum/app-sdk/protocol";
import { chmod, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";

// The core's end of an app's socket, for tests: it issues call ids, refuses
// anything naming a call that has ended and answers the app's calls from
// what the test gives it, so a runner can be tried with no core around it.
// Only the core's real end checks what an app may do.

export type PeerCalls = Partial<Omit<CoreCalls, "query" | "log">>;

type Hello = Extract<AppMessage, { type: "hello" }>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

export async function createCorePeer(options: {
  socket: string;
  calls?: PeerCalls;
  // How long each call has, unless it says.
  deadlineMs?: number;
}) {
  const calls: PeerCalls = options.calls ?? {};
  const hello = deferred<Hello>();
  const prepared = deferred<{ ready: boolean; message?: string }>();
  const closed = deferred<void>();
  let connection: Socket | undefined;

  // The calls under way, and the start context's, which lasts until stop.
  const live = new Set<string>();
  const answers = new Map<string, (outcome: Outcome) => void>();
  let lifetime: string | undefined;
  let lastCall = 0;
  let lastBeat = 0;
  const beats = new Map<number, () => void>();

  /** Every call the app made, in order, and what it named. */
  const requests: { call: string; method: string; params: unknown[] }[] = [];
  /** The calls it named that had ended, or never were. */
  const refused: string[] = [];
  /** Answers to calls that had ended, or never were. */
  const lateAnswers: string[] = [];
  const logs: string[] = [];
  /** Whatever it sent that the protocol doesn't allow. */
  const violations: string[] = [];
  const answered = new Map<string, Outcome>();
  let underWay = 0;
  const peer = { mostUnderWay: 0 };

  function send(message: CoreMessage) {
    connection?.write(encodeMessage(message));
  }

  async function serve(
    request: Extract<AppMessage, { type: "request" }>,
  ): Promise<Outcome> {
    const { call, method, params } = request;
    requests.push({ call, method, params });
    if (!live.has(call)) {
      refused.push(call);
      return failureOf(`Call ${call} has ended`);
    }
    const handler = calls[method as keyof PeerCalls] as
      ((...args: unknown[]) => Promise<unknown>) | undefined;
    if (!handler) {
      return failureOf(`This test's core has no ${method}`);
    }
    underWay += 1;
    peer.mostUnderWay = Math.max(peer.mostUnderWay, underWay);
    try {
      return { ok: true, value: await handler(...params) };
    } catch (error) {
      return isActionError(error)
        ? failureOf(error, error.code)
        : failureOf(error);
    } finally {
      underWay -= 1;
    }
  }

  function received(value: unknown) {
    const parsed = appMessageSchema.safeParse(value);
    if (!parsed.success) {
      violations.push(`Not a message: ${JSON.stringify(value)}`);
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "hello":
        hello.resolve(message);
        return;
      case "ready":
        prepared.resolve({ ready: true });
        return;
      case "failed":
        prepared.resolve({ ready: false, message: message.message });
        return;
      case "log":
        logs.push(message.message);
        return;
      case "pong":
        beats.get(message.beat)?.();
        beats.delete(message.beat);
        return;
      case "request":
        void serve(message).then((outcome) => {
          try {
            send({ type: "reply", id: message.id, outcome });
          } catch (error) {
            send({ type: "reply", id: message.id, outcome: failureOf(error) });
          }
        });
        return;
      case "answer": {
        const answer = answers.get(message.call);
        if (!answer) {
          lateAnswers.push(message.call);
          return;
        }
        answers.delete(message.call);
        answered.set(message.call, message.outcome);
        answer(message.outcome);
      }
    }
  }

  const server = createServer((socket) => {
    connection = socket;
    socket.on(
      "data",
      createMessageReader({
        message: received,
        violation: (reason) => violations.push(reason),
      }),
    );
    socket.on("error", () => undefined);
    socket.on("close", () => closed.resolve());
  });

  await unlink(options.socket).catch(() => undefined);
  await new Promise<void>((done, fail) => {
    server.once("error", fail);
    server.listen(options.socket, done);
  });
  // The app's process doesn't run as this one's user.
  await chmod(options.socket, 0o666);

  /** Calls the app, answering with the call's id and, when it ends, its outcome. */
  function issue(
    body: CallBody,
    { actor, deadlineMs }: { actor?: Actor; deadlineMs?: number } = {},
  ) {
    lastCall += 1;
    const id = `call-${lastCall}`;
    live.add(id);
    // A stop ends the context it stops, whatever starts after it.
    const ending = body.kind === "stop" ? lifetime : undefined;
    if (body.kind === "start") {
      lifetime = id;
    }
    const answer = new Promise<Outcome>((resolve) => {
      answers.set(id, (outcome) => {
        if (ending) {
          live.delete(ending);
          if (lifetime === ending) lifetime = undefined;
        }
        if (body.kind !== "start") {
          live.delete(id);
        }
        resolve(outcome);
      });
    });
    send({
      type: "call",
      id,
      actor: actor ?? { kind: "app", id: "test" },
      deadlineMs: deadlineMs ?? options.deadlineMs ?? 5_000,
      body,
    });
    return { id, answer };
  }

  return Object.assign(peer, {
    hello: hello.promise,
    prepared: prepared.promise,
    closed: closed.promise,
    requests,
    refused,
    lateAnswers,
    logs,
    violations,
    answered,

    welcome: (generation = 1) => send({ type: "welcome", generation }),
    refuse: (reason: string) => send({ type: "refused", reason }),
    issue,
    call: (body: CallBody, how?: { actor?: Actor; deadlineMs?: number }) =>
      issue(body, how).answer,
    /** Sends anything at all, as a broken core might. */
    sendRaw: (line: string) => connection?.write(line),

    /** Ends a call, as the core does when its time runs out. */
    end: (id: string) => {
      live.delete(id);
      answers.delete(id);
    },

    /** Resolves once the app answers a heartbeat. */
    beat() {
      lastBeat += 1;
      const beat = lastBeat;
      return new Promise<void>((resolve) => {
        beats.set(beat, resolve);
        send({ type: "ping", beat });
      });
    },

    /** Drops the connection, as a core that went away does. */
    drop: () => connection?.destroy(),

    async close() {
      connection?.destroy();
      await new Promise((done) => server.close(done));
    },
  });
}

export type CorePeer = Awaited<ReturnType<typeof createCorePeer>>;

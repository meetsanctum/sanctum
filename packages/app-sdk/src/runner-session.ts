import { connect, type Socket } from "node:net";

import {
  ActionError,
  actionErrorCodes,
  type ActionErrorCode,
  type AppDefinition,
} from "./index.js";
import {
  coreMessageSchema,
  createMessageReader,
  encodeMessage,
  failureOf,
  maxCallsUnderWay,
  protocolVersion,
  wordsOf,
  type AppMessage,
  type CoreCallMethod,
  type Outcome,
} from "./protocol.js";
import { createCallHost } from "./runner-calls.js";
import { openAppStorage, type AppStorage } from "./storage.js";

// One app's connection to the core, from its runner. The core hears the
// app's version and manifest before anything else happens: a version it
// refuses never runs its code or its migrations. Then the database opens and
// migrates, and the core learns the app is ready for calls. A core that goes,
// as when it restarts or updates, takes every call on its connection with it:
// the app stops as for a restart, or goes on if it has a resume, its process
// and database stay, and the runner says hello to the next core, which starts
// or resumes it there. Nothing
// from one connection is answered on the next. One that finds no core for
// 5 minutes ends the process, as does a stop that doesn't finish, and the
// core starts it afresh.

/** What a runner hosts: an app's package as it found it. */
export type RunnerPackage = {
  version: string;
  /** sanctum-app.json's sha-256, as hex. */
  manifest: string;
  /** Runs its entry only once the core has welcomed it. */
  load: () => Promise<{ app: AppDefinition; migrationsFolder?: string }>;
};

export type RunnerEnd = { code: number; reason: string };

const retryMs = 250;
// How long it looks for the next core, which an update may keep away while it
// checks it.
const defaultAwayWithinMs = 5 * 60_000;
// What a stop may take once the core has gone.
const defaultStopWithinMs = 8_000;
// How long one that went on, to resume, waits for the next core's start.
const defaultResumeWithinMs = 60_000;

// How the core refused one of the app's calls, as its code sees it: an
// ActionError for the codes apps tell apart.
function errorOf(outcome: Extract<Outcome, { ok: false }>) {
  return actionErrorCodes.includes(outcome.code as ActionErrorCode)
    ? new ActionError(outcome.code as ActionErrorCode, outcome.message)
    : new Error(outcome.message);
}

// The core's socket, once it listens: it may be restarting. Nothing comes of it
// once `given up` says the process is going.
async function connectToCore(
  path: string,
  withinMs: number,
  givenUp: () => boolean,
) {
  const deadline = Date.now() + withinMs;
  for (;;) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = connect(path);
        socket.once("error", reject);
        socket.once("connect", () => {
          socket.off("error", reject);
          resolve(socket);
        });
      });
    } catch (error) {
      if (Date.now() >= deadline || givenUp()) {
        throw error;
      }
      await new Promise((done) => setTimeout(done, retryMs));
    }
  }
}

export function runSession(options: {
  appId: string;
  /** The core's socket. */
  socket: string;
  /** The app's database file. */
  database: string;
  package: RunnerPackage;
  /** How long the core may take to appear. */
  connectWithinMs?: number;
  /** How long it looks for the next core once one has gone. */
  awayWithinMs?: number;
  /** What the app's stop may take once the core has gone. */
  stopWithinMs?: number;
  /** How long an app that went on, to resume, waits for the next core's start. */
  resumeWithinMs?: number;
  log?: (message: string) => void;
}) {
  const { appId } = options;
  const log = options.log ?? (() => undefined);

  let socket: Socket | undefined;
  let storage: AppStorage | undefined;
  let host: ReturnType<typeof createCallHost> | undefined;
  let welcomed = false;
  let ended = false;
  // Each connection in turn, so nothing of one reaches the next.
  let connection = 0;
  let isConnected = false;
  let finish!: (end: RunnerEnd) => void;
  const finished = new Promise<RunnerEnd>((resolve) => (finish = resolve));

  // Its calls into the core, at most so many at once: the rest wait their turn
  // here, in the app's own memory.
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  const waiting: (() => void)[] = [];
  let underWay = 0;
  let lastRequest = 0;

  // Every call of the app's into the core on that connection has failed, and
  // those waiting for a place fail as they wake.
  function failRequests() {
    for (const { reject } of pending.values()) {
      reject(new Error("The connection to the core has gone"));
    }
    pending.clear();
    underWay = 0;
    for (const wake of waiting.splice(0)) {
      wake();
    }
  }

  function end(code: number, reason: string) {
    if (ended) {
      return;
    }
    ended = true;
    isConnected = false;
    failRequests();
    socket?.destroy();
    storage?.close();
    finish({ code, reason });
  }

  function send(message: AppMessage) {
    socket?.write(encodeMessage(message));
  }

  async function request(
    call: string,
    method: CoreCallMethod,
    params: unknown[],
    hasEnded: () => boolean,
  ) {
    // While no core is there, nothing waits for one.
    if (ended || !isConnected) {
      throw new Error("The connection to the core has gone");
    }
    const on = connection;
    lastRequest += 1;
    const id = lastRequest;
    // One that would not fit fails its caller, and the connection goes on.
    const line = encodeMessage({ type: "request", id, call, method, params });
    if (underWay >= maxCallsUnderWay) {
      await new Promise<void>((wake) => waiting.push(wake));
    } else {
      underWay += 1;
    }
    // Woken because its connection went, which freed every place.
    if (ended || on !== connection || !isConnected) {
      throw new Error("The connection to the core has gone");
    }
    // Waiting for a slot may outlast the call that made the request.
    if (hasEnded()) {
      releaseRequest();
      throw new Error(`This call to ${appId} has ended`);
    }
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      socket?.write(line);
    });
  }

  function releaseRequest() {
    // The next one waiting takes over its place.
    const next = waiting.shift();
    if (next) next();
    else underWay -= 1;
  }

  function replied(id: number, outcome: Outcome) {
    const call = pending.get(id);
    if (!call) {
      return;
    }
    pending.delete(id);
    releaseRequest();
    if (outcome.ok) call.resolve(outcome.value);
    else call.reject(errorOf(outcome));
  }

  function answer(call: string, outcome: Outcome) {
    if (ended || !isConnected) {
      return;
    }
    try {
      send({ type: "answer", call, outcome });
    } catch (error) {
      // Too long, or not something JSON can say: the caller hears that instead.
      send({
        type: "answer",
        call,
        outcome: failureOf(`Its answer could not be sent: ${String(error)}`),
      });
    }
  }

  async function prepare() {
    try {
      const { app, migrationsFolder } = await options.package.load();
      if (ended) {
        return;
      }
      if (app.id !== appId) {
        throw new Error(`This package holds ${app.id}, not ${appId}`);
      }
      storage = openAppStorage(options.database, { appId, migrationsFolder });
      host = createCallHost({
        app,
        storage,
        request,
        answer,
        log(message) {
          if (!ended) {
            send({ type: "log", message: wordsOf(message) });
          }
        },
      });
      send({ type: "ready" });
    } catch (error) {
      const message = wordsOf(error);
      if (!ended) {
        send({ type: "failed", message });
      }
      end(1, `${appId} could not get ready: ${message}`);
    }
  }

  function received(value: unknown) {
    if (ended) {
      return;
    }
    const parsed = coreMessageSchema.safeParse(value);
    if (!parsed.success) {
      end(1, "The core sent something this runner does not understand");
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "welcome":
        if (!welcomed) {
          welcomed = true;
          // One that ran for a core before has its database open already.
          if (host) {
            send({ type: "ready" });
            host.resumesWithin(
              options.resumeWithinMs ?? defaultResumeWithinMs,
              options.stopWithinMs ?? defaultStopWithinMs,
            );
          } else void prepare();
        }
        return;
      case "refused":
        end(1, `The core refused ${appId}: ${message.reason}`);
        return;
      case "call":
        if (host) {
          const on = connection;
          host.take(message, (outcome) => {
            if (on === connection) answer(message.id, outcome);
          });
        } else answer(message.id, failureOf(`${appId} is not ready`));
        return;
      case "reply":
        replied(message.id, message.outcome);
        return;
      case "ping":
        send({ type: "pong", beat: message.beat });
    }
  }

  // Says hello on the core's socket, once it listens within `withinMs`.
  async function attach(withinMs: number) {
    let next: Socket;
    try {
      next = await connectToCore(options.socket, withinMs, () => ended);
    } catch (error) {
      end(1, `${appId} could not reach the core: ${String(error)}`);
      return;
    }
    if (ended) {
      next.destroy();
      return;
    }
    socket = next;
    isConnected = true;
    const on = connection;
    const read = createMessageReader({
      message: (value) => {
        if (on === connection) received(value);
      },
      violation: (reason) => end(1, reason),
    });
    next.on("data", read);
    next.on("error", (error) => log(`The socket failed: ${String(error)}`));
    next.on("close", () => {
      if (on === connection) lostCore();
    });
    send({
      type: "hello",
      protocol: protocolVersion,
      app: appId,
      version: options.package.version,
      manifest: options.package.manifest,
    });
  }

  // The core went with every call on its connection. An app that was ready
  // waits for the next core, stopped; before that there's nothing to keep.
  function lostCore() {
    if (ended) return;
    const ready = host;
    if (!ready) {
      end(1, "The connection to the core has gone");
      return;
    }
    connection += 1;
    isConnected = false;
    welcomed = false;
    socket = undefined;
    failRequests();
    log(`${appId} lost the core, and waits for the next`);
    void (async () => {
      if (!(await ready.lost(options.stopWithinMs ?? defaultStopWithinMs))) {
        end(1, `${appId} didn't stop in time once the core had gone`);
        return;
      }
      if (!ended) await attach(options.awayWithinMs ?? defaultAwayWithinMs);
    })();
  }

  void attach(options.connectWithinMs ?? 60_000);

  return {
    finished,

    // The process is going: the app's stop hook gets `capMs`, unless the core
    // has already called it, and its database closes so the file is whole.
    async shutdown(capMs: number) {
      if (!ended) {
        await host?.shutdown(capMs);
      }
      end(0, "Stopped");
      return finished;
    },
  };
}

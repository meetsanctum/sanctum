import {
  ActionError,
  actionErrorCodes,
  isActionError,
  NotReady,
  type ActionErrorCode,
  type Actor,
  type CoreCalls,
} from "@meetsanctum/app-sdk";
import {
  appMessageSchema,
  coreCallMethods,
  createMessageReader,
  encodeMessage,
  failureOf,
  maxCallsUnderWay,
  protocolVersion,
  type AppMessage,
  type CallBody,
  type CoreMessage,
  type Outcome,
} from "@meetsanctum/app-sdk/protocol";
import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, mkdir, unlink } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { dirname } from "node:path";

import { ActionCallError } from "./errors.js";

// The core's end of the socket to an app that runs apart. Whatever arrives
// is untrusted: only the SDK's rule keeps an app's own code off the socket,
// so nothing it says is believed beyond what it could do anyway. It can name
// only a call the core issued it and has not ended, and what a call may do
// was decided when the core issued it: its actor and its permissions never
// come from a message. What breaks the protocol ends the connection, which
// ends every call on it.

/** What the app's container may take to say anything, and then to get ready. */
const defaultHelloWithinMs = 10_000;
const defaultReadyWithinMs = 120_000;
/** How often the core asks whether the app is there, and the beats it may miss. */
const defaultHeartbeatMs = 5_000;
const maxMissedBeats = 3;
/** How long past its deadline a call may stay busy before the app counts as hung. */
const defaultGraceMs = 30_000;
/** What may wait for an app that isn't reading. */
const defaultMaxUnreadBytes = 8 * 1024 * 1024;
/** Connections that haven't said who they are. */
const maxConnections = 4;

const methods = new Set<string>(coreCallMethods);

type Open = {
  // What it may do, decided when the core issued it.
  core: CoreCalls;
  // The core's context behind the call, such as what caused it, for the activity
  // log: the app's calls back arrive with none of their own.
  enter: <T>(work: () => T) => T;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  // Past its deadline: nothing naming it is answered.
  ended: boolean;
  answered: boolean;
  timer?: NodeJS.Timeout;
};

type Connection = {
  socket: Socket;
  phase: "hello" | "preparing" | "ready" | "gone";
  generation: number;
  calls: Map<string, Open>;
  // The start context's call, which lasts until stop has answered.
  lifetime?: string;
  lastCall: number;
  // The core's calls that have yet to answer, and the app's it has yet to.
  awaited: number;
  requests: number;
  missedBeats: number;
  lastBeat: number;
  timer?: NodeJS.Timeout;
  beats?: NodeJS.Timeout;
};

function errorOf(outcome: Extract<Outcome, { ok: false }>) {
  if (outcome.code === "invalid_request" || outcome.code === "unavailable") {
    return new ActionCallError(outcome.code);
  }
  if (outcome.code === "not_ready") {
    return new NotReady(outcome.message);
  }
  return actionErrorCodes.includes(outcome.code as ActionErrorCode)
    ? new ActionError(outcome.code as ActionErrorCode, outcome.message)
    : new Error(outcome.message);
}

export function createAppLink(options: {
  appId: string;
  // What it must say it is: the version the core expects to run, and its
  // manifest's digest. A package that doesn't match never gets further.
  version: string;
  manifest: string;
  /**
   * Why one that says it is that package is not the one the core waits for,
   * if it isn't: a build of the same version says the same of itself.
   */
  refuses?: () => string | undefined;
  /** Where the core listens, in the app's folder of sockets. */
  socket: string;
  log: (message: string) => void;
  /** A new connection's database is open and migrated, so it takes calls. */
  onReady: () => void;
  /**
   * The connection went, whatever the reason: every call on it has failed.
   * `hung` says the app stopped answering, so its process may still be there.
   */
  onGone: (reason: string, hung: boolean) => void;
  helloWithinMs?: number;
  readyWithinMs?: number;
  heartbeatMs?: number;
  graceMs?: number;
  maxUnreadBytes?: number;
}) {
  const { appId, log } = options;
  const graceMs = options.graceMs ?? defaultGraceMs;
  const maxUnreadBytes = options.maxUnreadBytes ?? defaultMaxUnreadBytes;
  const connections = new Set<Connection>();
  let current: Connection | undefined;
  let lastGeneration = 0;
  let closed = false;

  function drop(connection: Connection, reason: string, hung = false) {
    if (connection.phase === "gone") {
      return;
    }
    connection.phase = "gone";
    connections.delete(connection);
    clearTimeout(connection.timer);
    clearInterval(connection.beats);
    connection.socket.destroy();
    for (const open of connection.calls.values()) {
      clearTimeout(open.timer);
      if (!open.answered) {
        open.reject(new ActionCallError("unavailable"));
      }
    }
    connection.calls.clear();
    if (current === connection) {
      current = undefined;
      if (!closed) {
        log(`apps: ${appId}'s connection ended: ${reason}`);
        options.onGone(reason, hung);
      }
    }
  }

  function send(connection: Connection, message: CoreMessage) {
    connection.socket.write(encodeMessage(message));
    // An app that doesn't read can't make the core hold its answers for ever.
    if (connection.socket.writableLength > maxUnreadBytes) {
      drop(connection, "it stopped reading");
    }
  }

  function refuse(connection: Connection, reason: string) {
    log(`apps: ${appId} was refused: ${reason}`);
    connection.phase = "gone";
    connections.delete(connection);
    clearTimeout(connection.timer);
    connection.socket.write(encodeMessage({ type: "refused", reason }));
    connection.socket.destroySoon();
  }

  function hello(
    connection: Connection,
    said: Extract<AppMessage, { type: "hello" }>,
  ) {
    const refusal =
      said.protocol !== protocolVersion
        ? `it speaks protocol ${said.protocol}, and this core speaks ${protocolVersion}`
        : said.app !== appId
          ? `this is ${appId}'s socket, and it says it is ${said.app}`
          : said.version !== options.version
            ? `it is version ${said.version}, and this core expects ${options.version}`
            : said.manifest !== options.manifest
              ? `its manifest isn't the one staged for version ${options.version}`
              : options.refuses?.();
    if (refusal) {
      refuse(connection, refusal);
      return;
    }
    // Nothing from the old connection is answered or replayed after this.
    if (current) {
      drop(current, "a new connection took over");
    }
    current = connection;
    lastGeneration += 1;
    connection.generation = lastGeneration;
    connection.phase = "preparing";
    clearTimeout(connection.timer);
    connection.timer = setTimeout(
      () => drop(connection, "it didn't get ready in time"),
      options.readyWithinMs ?? defaultReadyWithinMs,
    );
    send(connection, { type: "welcome", generation: lastGeneration });
  }

  function ready(connection: Connection) {
    clearTimeout(connection.timer);
    connection.phase = "ready";
    // Only from here: migrating blocks the runner, which can't answer meanwhile.
    connection.beats = setInterval(() => {
      if (connection.missedBeats >= maxMissedBeats) {
        drop(connection, `it missed ${maxMissedBeats} heartbeats`, true);
        return;
      }
      connection.missedBeats += 1;
      connection.lastBeat += 1;
      send(connection, { type: "ping", beat: connection.lastBeat });
    }, options.heartbeatMs ?? defaultHeartbeatMs);
    connection.beats.unref();
    options.onReady();
  }

  function answered(
    connection: Connection,
    { call, outcome }: Extract<AppMessage, { type: "answer" }>,
  ) {
    const open = connection.calls.get(call);
    // An answer to nothing, or a second one, changes nothing.
    if (!open || open.answered) {
      return;
    }
    open.answered = true;
    clearTimeout(open.timer);
    connection.awaited -= 1;
    if (call !== connection.lifetime || !outcome.ok) {
      connection.calls.delete(call);
      if (connection.lifetime === call) connection.lifetime = undefined;
    }
    if (outcome.ok) open.resolve(outcome.value);
    else open.reject(errorOf(outcome));
  }

  function requested(
    connection: Connection,
    { id, call, method, params }: Extract<AppMessage, { type: "request" }>,
  ) {
    // Nothing from an old connection is answered.
    const reply = (outcome: Outcome) => {
      if (connection.phase !== "ready") {
        return;
      }
      try {
        send(connection, { type: "reply", id, outcome });
      } catch (error) {
        // Too long, or not something JSON can say.
        send(connection, { type: "reply", id, outcome: failureOf(error) });
      }
    };
    const open = connection.calls.get(call);
    if (!open || open.ended) {
      reply(failureOf(`The call ${call} has ended`));
      return;
    }
    if (!methods.has(method)) {
      reply(failureOf(`There is no call ${method}`));
      return;
    }
    if (connection.requests >= maxCallsUnderWay) {
      reply(failureOf(`More than ${maxCallsUnderWay} calls are under way`));
      return;
    }
    connection.requests += 1;
    const handler = open.core[method as keyof CoreCalls] as (
      ...args: unknown[]
    ) => Promise<unknown>;
    void open
      .enter(async () => handler(...params))
      .then(
        (value): Outcome => ({ ok: true, value }),
        (error: unknown): Outcome =>
          isActionError(error)
            ? failureOf(error, error.code)
            : failureOf(error),
      )
      .then((outcome) => {
        connection.requests -= 1;
        reply(outcome);
      });
  }

  function received(connection: Connection, value: unknown) {
    if (connection.phase === "gone") {
      return;
    }
    const parsed = appMessageSchema.safeParse(value);
    if (!parsed.success) {
      drop(connection, "it sent something the protocol doesn't allow");
      return;
    }
    const message = parsed.data;
    if (connection.phase === "hello") {
      if (message.type === "hello") hello(connection, message);
      else drop(connection, "it didn't say who it is first");
      return;
    }
    switch (message.type) {
      case "log":
        log(`${appId}: ${message.message}`);
        return;
      case "pong":
        connection.missedBeats = 0;
        return;
    }
    if (connection.phase === "preparing") {
      if (message.type === "ready") ready(connection);
      else if (message.type === "failed") {
        drop(connection, `it could not get ready: ${message.message}`);
      } else drop(connection, "it did something before it was ready");
      return;
    }
    switch (message.type) {
      case "answer":
        answered(connection, message);
        return;
      case "request":
        requested(connection, message);
        return;
      default:
        drop(connection, `it said ${message.type} after it was ready`);
    }
  }

  const server = createServer((socket) => {
    const connection: Connection = {
      socket,
      phase: "hello",
      generation: 0,
      calls: new Map(),
      lastCall: 0,
      awaited: 0,
      requests: 0,
      missedBeats: 0,
      lastBeat: 0,
    };
    connections.add(connection);
    connection.timer = setTimeout(
      () => drop(connection, "it didn't say who it is"),
      options.helloWithinMs ?? defaultHelloWithinMs,
    );
    socket.on(
      "data",
      createMessageReader({
        message: (value) => received(connection, value),
        violation: (reason) => drop(connection, reason),
      }),
    );
    socket.on("error", () => undefined);
    socket.on("close", () => drop(connection, "it closed"));
  });
  server.maxConnections = maxConnections;

  return {
    /** Listens in the app's folder. The app's mount of it is read-only, so it can't swap the socket. */
    async listen() {
      await mkdir(dirname(options.socket), { recursive: true });
      await unlink(options.socket).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(options.socket, () => {
          server.off("error", reject);
          resolve();
        });
      });
      // The app's process runs as another user than the core's.
      await chmod(options.socket, 0o666);
    },

    /** Whether the app takes calls now. */
    isReady: () => current?.phase === "ready",

    /** Whether it said hello; preparing its database has its own deadline. */
    isConnected: () => current !== undefined,

    /**
     * Calls the app, with the core's calls this one may make. It settles with
     * the app's answer or when the connection goes; its caller stops waiting at
     * the deadline. An app still busy with it a while after that counts as hung.
     */
    call(core: CoreCalls, actor: Actor, body: CallBody, deadlineMs: number) {
      const connection = current;
      if (
        connection?.phase !== "ready" ||
        connection.awaited >= maxCallsUnderWay
      ) {
        return Promise.reject(new ActionCallError("unavailable"));
      }
      connection.lastCall += 1;
      const id = `${connection.generation}.${connection.lastCall}`;
      return new Promise<unknown>((resolve, reject) => {
        const open: Open = {
          core,
          enter: AsyncLocalStorage.snapshot(),
          resolve,
          reject,
          ended: false,
          answered: false,
        };
        // One too long for a message fails its caller, and nothing went.
        const line = encodeMessage({
          type: "call",
          id,
          actor,
          deadlineMs,
          body,
        });
        connection.calls.set(id, open);
        connection.awaited += 1;
        if (body.kind === "start") {
          connection.lifetime = id;
        }
        if (body.kind === "stop") {
          // Its start's context ends with it, whatever has started since.
          const ending = connection.lifetime ?? "";
          const end = () => {
            connection.calls.delete(ending);
            if (connection.lifetime === ending) {
              connection.lifetime = undefined;
            }
          };
          open.resolve = (value) => {
            end();
            resolve(value);
          };
          open.reject = (error) => {
            end();
            reject(error);
          };
        }
        open.timer = setTimeout(() => {
          // A start's context outlives its time: what it set going goes on.
          open.ended = id !== connection.lifetime;
          open.timer = setTimeout(() => {
            drop(
              connection,
              `it was still busy with a call ${graceMs} ms past its deadline`,
              true,
            );
          }, graceMs);
          open.timer.unref();
        }, deadlineMs);
        open.timer.unref();
        connection.socket.write(line);
        if (connection.socket.writableLength > maxUnreadBytes) {
          drop(connection, "it stopped reading");
        }
      });
    },

    /** Stops listening and ends the connection, saying nothing to the core. */
    async close() {
      closed = true;
      for (const connection of [...connections]) {
        drop(connection, "the core is closing");
      }
      await new Promise((done) => server.close(done));
      await unlink(options.socket).catch(() => undefined);
    },
  };
}

export type AppLink = ReturnType<typeof createAppLink>;

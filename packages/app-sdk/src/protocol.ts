import { z } from "zod";

import type { CoreCalls } from "./context.js";
import type { CoreEvent } from "./core-events.js";
import {
  actionErrorCodes,
  actorSchema,
  startReasons,
  stopReasons,
} from "./index.js";

// What an app's runner and the core say to each other over the Unix socket
// between them: one JSON message a line. Both ends parse what arrives with
// these schemas. The core treats whatever arrives as untrusted, since only
// the SDK's rule keeps an app's own code off the socket.

/**
 * The runner speaks the version its app's SDK was built for; the core refuses
 * one it doesn't support. A version adds calls and keeps what the one before
 * says, so a core speaks every version from `oldestProtocolVersion` on: an
 * app that kept running through a core's update goes on with the new core.
 */
export const protocolVersion = 4;
/** The oldest version a core still speaks. */
export const oldestProtocolVersion = 1;

/** The socket's name in an app's folder of sockets, where the core listens. */
export const coreSocketName = "core.sock";
/** The app's database, in its data folder. */
export const appDatabaseName = "app.db";

/** A message is at most this long, its line's end aside. */
export const maxMessageBytes = 1024 * 1024;
/** The calls one side may have under way with the other at once. */
export const maxCallsUnderWay = 64;

// A failure's words are for a log, so they never need to be long.
const maxWords = 4_096;

/**
 * The calls an app makes into the core that cross the socket: every one of
 * CoreCalls but `query`, which stays on the app's side with its database, and
 * `log`, which is a message of its own and has no answer.
 */
export const coreCallMethods = [
  "serviceConnection",
  "settings",
  "permissions",
  "permissionsRevision",
  "people",
  "places",
  "location",
  "devices",
  "device",
  "command",
  "register",
  "report",
  "present",
  "press",
  "release",
  "firmware",
  "emit",
  "follow",
  "scheduleJob",
  "cancelJob",
  "jobs",
  "putWorkflow",
  "removeWorkflow",
  "workflows",
  "publish",
  "unpublish",
  "entities",
  "fetch",
  "joining",
  "problem",
  "secret",
  "putSecret",
  "removeSecret",
] as const satisfies readonly Exclude<keyof CoreCalls, "query" | "log">[];
export type CoreCallMethod = (typeof coreCallMethods)[number];

// A new call added to CoreCalls has to cross the socket too.
const everyCallCrosses: [
  Exclude<keyof CoreCalls, "query" | "log" | CoreCallMethod>,
] extends [never]
  ? true
  : never = true;
void everyCallCrosses;

/** The Drivers contract's hooks, which the core hands a driver app by name. */
export const driverHooks = [
  "command",
  "move",
  "pairing.open",
  "pairing.close",
  "remove",
  "firmware.check",
  "firmware.update",
  "firmware.stop",
  "probe",
  "repair",
  "discovered",
] as const;
export type DriverHook = (typeof driverHooks)[number];

/** A refusal's code, which the caller gets as it is. Without one, a failure is the app's. */
export const refusalCodes = [
  ...actionErrorCodes,
  "invalid_request",
  "unavailable",
  // Its start said what it waits for.
  "not_ready",
] as const;
export type RefusalCode = (typeof refusalCodes)[number];

/** How a call ended, in either direction. */
export const outcomeSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.unknown().optional() }),
  z.object({
    ok: z.literal(false),
    code: z.enum(refusalCodes).optional(),
    message: z.string().max(maxWords),
  }),
]);
export type Outcome = z.infer<typeof outcomeSchema>;

/** Words for a log or a failure, short enough for any message. */
export function wordsOf(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    maxWords,
  );
}

/** A call that failed, or was refused when it has a code. */
export function failureOf(
  error: unknown,
  code?: RefusalCode,
): Extract<Outcome, { ok: false }> {
  return { ok: false, ...(code ? { code } : {}), message: wordsOf(error) };
}

const callId = z.string().min(1).max(64);

/** What the core calls an app for. */
export const callBodySchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("start"),
      reason: z.enum(startReasons),
      from: z.string().min(1).optional(),
      // After a change of version: the update it commits.
      update: callId.optional(),
    })
    .refine(
      (body) =>
        (body.reason !== "updated" && body.reason !== "rolledBack") ||
        body.from !== undefined,
      {
        message: "A start on another version needs the version it came from",
        path: ["from"],
      },
    ),
  z.object({ kind: z.literal("stop"), reason: z.enum(stopReasons) }),
  z.object({
    kind: z.literal("action"),
    action: z.string().min(1),
    input: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("driver"),
    hook: z.enum(driverHooks),
    params: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal("event"),
    event: z.custom<CoreEvent>(
      (value) => typeof (value as { name?: unknown } | null)?.name === "string",
    ),
  }),
]);
export type CallBody = z.infer<typeof callBodySchema>;

const callMessage = z.object({
  type: z.literal("call"),
  // Issued by the core. Whatever the app does for this call names it.
  id: callId,
  // The person, client, workflow or app behind the call.
  actor: actorSchema,
  // How long it has, from when it arrives. The core ends it after that.
  deadlineMs: z.number().int().positive(),
  body: callBodySchema,
});
export type CallMessage = z.infer<typeof callMessage>;

/** What the core says to an app's runner. */
export const coreMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("welcome"), generation: z.number().int() }),
  z.object({ type: z.literal("refused"), reason: z.string() }),
  callMessage,
  z.object({
    type: z.literal("reply"),
    id: z.number().int(),
    outcome: outcomeSchema,
  }),
  z.object({ type: z.literal("ping"), beat: z.number().int() }),
]);
export type CoreMessage = z.infer<typeof coreMessageSchema>;

/** What an app's runner says to the core. */
export const appMessageSchema = z.discriminatedUnion("type", [
  // The first message of every connection, whose shape every version keeps.
  z.object({
    type: z.literal("hello"),
    protocol: z.number().int(),
    app: z.string().min(1).max(128),
    version: z.string().min(1).max(64),
    // sanctum-app.json's sha-256, as hex.
    manifest: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  // Its database is open and migrated, so it takes calls.
  z.object({ type: z.literal("ready") }),
  // It could not get that far, so it is about to exit.
  z.object({ type: z.literal("failed"), message: z.string().max(maxWords) }),
  z.object({
    type: z.literal("answer"),
    call: callId,
    outcome: outcomeSchema,
  }),
  z.object({
    type: z.literal("request"),
    id: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    call: callId,
    // A string here, so the core can refuse an unknown one and go on.
    method: z.string().min(1).max(64),
    params: z.array(z.unknown()).max(1),
  }),
  z.object({ type: z.literal("log"), message: z.string().max(maxWords) }),
  z.object({ type: z.literal("pong"), beat: z.number().int() }),
]);
export type AppMessage = z.infer<typeof appMessageSchema>;

/** A message that would not fit, which is its sender's to deal with. */
export class MessageTooLarge extends Error {}

/** A message as a line for the socket. */
export function encodeMessage(message: AppMessage | CoreMessage) {
  const text = JSON.stringify(message);
  if (Buffer.byteLength(text) > maxMessageBytes) {
    throw new MessageTooLarge(
      `A message of ${Buffer.byteLength(text)} bytes is over the limit of ${maxMessageBytes}`,
    );
  }
  return `${text}\n`;
}

/**
 * Splits what arrives on a socket into messages, parsed as JSON and not yet
 * checked, and stops for good at a line too long or not JSON at all.
 */
export function createMessageReader(handlers: {
  message: (value: unknown) => void;
  violation: (reason: string) => void;
}) {
  let pending: Buffer[] = [];
  let size = 0;
  let stopped = false;
  const violate = (reason: string) => {
    stopped = true;
    pending = [];
    handlers.violation(reason);
  };
  const tooLong = () =>
    violate(`A message went over the limit of ${maxMessageBytes} bytes`);

  return (chunk: Buffer) => {
    let from = 0;
    while (!stopped) {
      const end = chunk.indexOf(0x0a, from);
      if (end === -1) {
        break;
      }
      const piece = chunk.subarray(from, end);
      from = end + 1;
      if (size + piece.length > maxMessageBytes) {
        tooLong();
        return;
      }
      const line = size === 0 ? piece : Buffer.concat([...pending, piece]);
      pending = [];
      size = 0;
      let value: unknown;
      try {
        value = JSON.parse(line.toString("utf8"));
      } catch {
        violate("A message was not JSON");
        return;
      }
      handlers.message(value);
    }
    if (stopped || from >= chunk.length) {
      return;
    }
    size += chunk.length - from;
    if (size > maxMessageBytes) {
      tooLong();
      return;
    }
    pending.push(chunk.subarray(from));
  };
}

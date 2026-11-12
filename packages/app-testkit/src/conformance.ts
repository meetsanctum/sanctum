import { ActionError, type StaticManifest } from "@meetsanctum/app-sdk";
import { manifestDigest } from "@meetsanctum/app-sdk/package";
import type { Outcome } from "@meetsanctum/app-sdk/protocol";
import { readFile } from "node:fs/promises";

import { createCorePeer, type PeerCalls } from "./core-peer.js";

// What every app must do through its socket in its real container: name its
// version and manifest before anything else, open its database, start,
// answer its read actions, stop and start again. One whose start says it's
// waiting for what it needs, as a driver does for a service this home can't
// reach, gets no other calls, as the core sends it none, and is stopped and
// started again. It runs beside the app's container, and says what it saw as
// one line of JSON, which apps/manager's real-image test judges. A second
// line follows once the app's container has stopped.
//
//   node conformance.js <core socket> <the app's sanctum-app.json>

// An empty home, in which every call an app makes is answered as the core
// would for an app holding everything it asks for.
function emptyHome(manifest: StaticManifest): PeerCalls {
  const notFound = async () => {
    throw new ActionError("not_found");
  };
  const done = async () => undefined;
  return {
    // A broker nobody can reach, so a driver's start says it's waiting for it.
    serviceConnection: async () => ({
      mqtt: {
        url: "mqtt://127.0.0.1:1",
        username: "conformance",
        password: "conformance",
        topics: [],
      },
    }),
    settings: async () => ({}),
    permissions: async () => manifest.permissions.map(({ id }) => id),
    permissionsRevision: async () => 0,
    people: async () => [],
    places: async () => ({
      home: { name: "Home", timeZone: "UTC", temperatureUnit: "celsius" },
      floors: [],
      rooms: [],
      zones: [],
    }),
    location: async () => null,
    devices: async () => [],
    device: notFound,
    command: notFound,
    register: async ({ key }) => ({ id: `device:${key}` }),
    report: done,
    present: done,
    press: done,
    release: done,
    firmware: done,
    emit: done,
    follow: done,
    scheduleJob: async (job) => ({ ...job, nextAt: null }) as never,
    cancelJob: done,
    jobs: async () => [],
    removeWorkflow: done,
    workflows: async () => [],
    publish: done,
    unpublish: done,
    entities: async () => [],
    fetch: async () => {
      throw new Error("There is no internet here");
    },
    joining: done,
  };
}

export type ConformanceReport = {
  hello: unknown;
  expected: { app: string; version: string; manifest: string };
  prepared: { ready: boolean; message?: string };
  started: Outcome;
  reads: { action: string; outcome: Outcome }[];
  // Null for one whose start said it's waiting.
  unknownAction: Outcome | null;
  unknownDevice: Outcome | null;
  stopped: Outcome;
  startedAgain: Outcome;
  madeCalls: string[];
  refused: string[];
  lateAnswers: string[];
  violations: string[];
  logs: string[];
};

const socket = process.argv[2];
const manifestFile = process.argv[3];
if (!socket || !manifestFile) {
  throw new Error("Usage: conformance.js <core socket> <sanctum-app.json>");
}

const text = await readFile(manifestFile);
const manifest = JSON.parse(text.toString("utf8")) as StaticManifest;
const peer = await createCorePeer({
  socket,
  calls: emptyHome(manifest),
  deadlineMs: 30_000,
});

const hello = await peer.hello;
peer.welcome();
const prepared = await peer.prepared;

const report: ConformanceReport = {
  hello,
  expected: {
    app: manifest.id,
    version: manifest.version,
    manifest: manifestDigest(text),
  },
  prepared,
  started: await peer.call({ kind: "start", reason: "started" }),
  reads: [],
  // Replaced below; the report is complete before it is printed.
  unknownAction: null,
  unknownDevice: null,
  stopped: { ok: true },
  startedAgain: { ok: true },
  madeCalls: [],
  refused: peer.refused,
  lateAnswers: peer.lateAnswers,
  violations: peer.violations,
  logs: peer.logs,
};

const isWaiting = !report.started.ok && report.started.code === "not_ready";
if (!isWaiting) {
  for (const action of manifest.actions.filter(({ tier }) => tier === "read")) {
    report.reads.push({
      action: action.id,
      outcome: await peer.call({
        kind: "action",
        action: action.id,
        input: {},
      }),
    });
  }
  report.unknownAction = await peer.call({
    kind: "action",
    action: `${manifest.id}.no-such-action`,
    input: {},
  });
  report.unknownDevice = await peer.call(
    {
      kind: "driver",
      hook: "command",
      params: {
        key: "no-such-device",
        device: "device:no-such-device",
        capability: "switch",
        kind: "switch",
        command: { on: true },
      },
    },
    { actor: { kind: "user", id: "conformance" } },
  );
}
report.stopped = await peer.call({ kind: "stop", reason: "shutdown" });
report.startedAgain = await peer.call({ kind: "start", reason: "started" });
report.madeCalls = [...new Set(peer.requests.map(({ method }) => method))];

console.log(JSON.stringify(report));

// The suite stops its container now, with the app running.
await peer.closed;
console.log(JSON.stringify({ closed: true }));
await peer.close();
process.exit(0);

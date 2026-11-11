import { join } from "node:path";
import type { WebSocket } from "ws";

import type { AppPackage, Origin } from "../src/app-host/host.js";
import { loadAppPackage } from "../src/app-host/loader.js";
import { radio } from "./fixtures/apps/lamps/index.js";
import {
  claimed,
  fixtureApps,
  get,
  post,
  testCore,
  type TestCore,
} from "./support.js";

// A home with the lamps driver's pretend radio (test/fixtures/apps/lamps): a
// kitchen lamp and a kettle plug, the panel app that uses lights, and Maya,
// who claimed the host.

export { radio };

export async function lampsCore(
  options: {
    origin?: Origin;
    confirmMs?: number;
    appTimeoutMs?: number;
    firmwareStaleMs?: number;
    probeWaitMs?: number;
    holdLimitMs?: number;
    holdSettleMs?: number;
    apps?: readonly AppPackage[];
  } = {},
) {
  radio.reset();
  await radio.add("lamp-1", "light", "Kitchen lamp");
  await radio.add("plug-1", "switch", "Kettle plug");
  const lamps = await loadAppPackage(
    join(fixtureApps, "lamps"),
    options.origin ?? "system",
  );
  const panel = await loadAppPackage(join(fixtureApps, "panel"), "system");
  const core = await testCore({
    apps: [lamps, panel, ...(options.apps ?? [])],
    confirmMs: options.confirmMs,
    appTimeoutMs: options.appTimeoutMs,
    firmwareStaleMs: options.firmwareStaleMs,
    probeWaitMs: options.probeWaitMs,
    holdLimitMs: options.holdLimitMs,
    holdSettleMs: options.holdSettleMs,
  });
  radio.clock = core.now;
  const maya = await claimed(core);
  const devices = (
    await get(core, "/api/devices", { token: maya.token })
  ).json();
  // By what the driver calls them: the core names them after their room.
  const idOf = (driverName: string) =>
    devices.find(
      (device: { driverName: string }) => device.driverName === driverName,
    ).id;
  return {
    core,
    maya,
    lamp: idOf("Kitchen lamp") as string,
    plug: idOf("Kettle plug") as string,
  };
}

// Someone with a personal client of their own, as signing in creates one.
export function personWithClient(core: TestCore, name = "Ben") {
  const person = core.people.add({ name, colour: "#8fb5c9" });
  const { token, client } = core.auth.clients.createPersonal({
    name: `${name}'s phone`,
    platform: "android",
    personId: person.id,
  });
  return { person, token, client };
}

export function command(
  core: TestCore,
  token: string,
  device: string,
  capability: string,
  body: object,
) {
  return post(
    core,
    "/api/devices/command",
    { device, capability, command: body },
    { token },
  );
}

// In the order of what their drivers call them, which the tests know them
// by: the core names them after their room and type.
export async function devicesSeenBy(core: TestCore, token: string) {
  return (await get(core, "/api/devices", { token }))
    .json()
    .sort((a: { driverName: string }, b: { driverName: string }) =>
      a.driverName.localeCompare(b.driverName),
    );
}

// Waits until the radio's reports have reached the core.
export const settled = () => new Promise((resolve) => setImmediate(resolve));

// A live connection, authenticated and ready, collecting what it is sent.
export async function openLive(core: TestCore, token: string) {
  await core.server.ready();
  const socket: WebSocket = await core.server.injectWS("/api/live");
  const messages: { type: string; [field: string]: unknown }[] = [];
  const closed = new Promise<{ code: number }>((resolve) =>
    socket.on("close", (code) => resolve({ code })),
  );
  const ready = new Promise((resolve) => socket.once("message", resolve));
  socket.send(JSON.stringify({ type: "auth", token }));
  await ready;
  socket.on("message", (data) => messages.push(JSON.parse(String(data))));
  return { socket, messages, closed };
}

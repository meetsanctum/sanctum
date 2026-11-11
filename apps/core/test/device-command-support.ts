import { afterEach, vi } from "vitest";

import { createDevices, type Deliver } from "../src/devices/devices.js";
import { testCore } from "./support.js";

function deferredDelivery() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((accept, refuse) => {
    resolve = accept;
    reject = refuse;
  });
  return { promise, resolve, reject };
}

const opened: ReturnType<typeof createDevices>[] = [];
afterEach(() => {
  for (const devices of opened.splice(0)) devices.close();
  vi.useRealTimers();
});

export async function setupCommands() {
  const core = await testCore();
  const deliveries: ReturnType<typeof deferredDelivery>[] = [];
  const deliver: Deliver = vi.fn(() => {
    const delivery = deferredDelivery();
    deliveries.push(delivery);
    return delivery.promise;
  });
  const devices = createDevices(core.db, {
    gate: core.gate,
    places: core.places,
    activity: core.activity,
    deliver,
    confirmMs: 100,
  });
  opened.push(devices);
  const registration = {
    key: "lamp",
    name: "Lamp",
    capabilities: [
      { id: "light", kind: "light" as const, features: { brightness: true } },
    ],
  };
  const { id } = devices.register("test.driver", registration);
  const report = (brightness: number) =>
    devices.report("test.driver", {
      key: "lamp",
      states: { light: { on: true, brightness } },
    });
  report(80);
  const state = () => devices.get(id)!.capabilities[0]!;
  const command = (brightness: number) =>
    devices.command(
      { kind: "app", id: "test.panel" },
      { device: id, capability: "light", command: { brightness } },
      {},
      "test.panel",
    );
  // What each delivery asked of the driver, in order.
  const sent = () =>
    vi.mocked(deliver).mock.calls.map(([, { command }]) => command);
  // The command that went again at its deadline, delivered and unanswered
  // for as long again.
  const unansweredAgain = async () => {
    deliveries.at(-1)!.resolve();
    await vi.advanceTimersByTimeAsync(100);
  };
  vi.useFakeTimers();
  return {
    core,
    devices,
    id,
    registration,
    deliver,
    deliveries,
    command,
    report,
    state,
    sent,
    unansweredAgain,
  };
}

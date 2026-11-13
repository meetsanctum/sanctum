import type { ServiceConnection } from "@meetsanctum/app-sdk";
import { describe, expect, it } from "vitest";

import { createCoreCalls } from "../src/app-host/calls.js";
import { testCore } from "./support.js";

describe("service connections from ended contexts", () => {
  it.each([true, false])(
    "refuses credentials after the context ends (already ended: %s)",
    async (hasEndedBeforeRequest) => {
      const core = await testCore();
      let resolveConnection!: (connection: ServiceConnection) => void;
      const connection = new Promise<ServiceConnection>((resolve) => {
        resolveConnection = resolve;
      });
      let hasEnded = hasEndedBeforeRequest;
      const calls = createCoreCalls({
        appId: "test.driver",
        actor: { kind: "app", id: "test.driver" },
        permissions: () => ["services:mosquitto"],
        permissionsRevision: () => 0,
        query: async () => ({}),
        ended: () => hasEnded,
        services: new Map([["mosquitto", connection]]),
        people: core.people,
        places: core.places,
        devices: core.devices,
        presses: core.presses,
        firmware: core.firmware,
        emit() {},
        entities: core.entities,
        entityType: () => undefined,
        isTileType: () => false,
        settings: () => ({}),
        net: async () => {
          throw new Error("No internet here");
        },
        watch: () => ({ signal: new AbortController().signal, done() {} }),
        pairing: () => core.pairing,
        secrets: { get: () => null, put() {}, remove() {} },
        log() {},
      });
      const requested = calls.serviceConnection("mosquitto");
      const refused = expect(requested).rejects.toThrow(/has ended/);
      hasEnded = true;
      resolveConnection({});
      await refused;
    },
  );
});

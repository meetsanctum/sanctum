import type {
  CapabilityInfo,
  DeviceInfo,
  LightsResult,
  PairingInfo,
  PressCapture,
  ProbeResult,
} from "@meetsanctum/app-sdk";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type { Activity } from "../activity/activity.js";
import { ActionCallError } from "../app-host/errors.js";
import type { Gate, Rule } from "../app-host/gate.js";
import { commandFromPage, devicesForPage } from "../app-host/page-requests.js";
import { changedBy } from "../auth/callers.js";
import type { Principal } from "../auth/clients.js";
import type { Devices } from "./devices.js";
import { removalRule } from "./removal.js";
import { firmwareRules, type Firmware } from "./firmware.js";
import type { Lights } from "./lights.js";
import { pairingRules, type Pairing } from "./pairing.js";
import type { Presses } from "./presses.js";

// Devices' client routes. A command goes through the permission gate like an
// app's action, as the person or shared client behind the request. Every
// client sees, controls and manages every device, shared ones too: adding
// them, with the gate's tiers, and removing them. A room's and Lights'
// button switch a place's lights together (lights.ts). A client captures a
// remote's presses while someone picks one, as they change workflows, for an
// app's page or its own, and only it stops that capture (presses.ts). Every
// client checks for firmware updates, starts and stops them, and checks a
// device's connection (firmware.ts).
//
//   GET  /api/devices                DeviceInfo[] the caller may see
//   POST /api/devices/command        { device, capability, command } → CapabilityInfo
//   POST /api/devices/lights         { place, to } → LightsResult
//   POST /api/devices/update         { id, name?, roomId? } → DeviceInfo
//   POST /api/devices/remove         { id, force? } → { id }
//   GET  /api/devices/pairing        PairingInfo
//   POST /api/devices/pairing/open   { seconds? } → PairingInfo & { since }
//   POST /api/devices/pairing/close  PairingInfo
//   POST /api/devices/capture/start  { device, app? } → PressCapture
//   POST /api/devices/capture/stop   { id }
//   POST /api/devices/firmware/check { id } → DeviceInfo
//   POST /api/devices/firmware/update { id } → DeviceInfo
//   POST /api/devices/firmware/stop  { id } → DeviceInfo
//   POST /api/devices/probe          { id } → ProbeResult

export function registerDeviceRoutes(
  app: FastifyInstance,
  options: {
    devices: Devices;
    lights: Lights;
    pairing: Pairing;
    presses: Presses;
    firmware: Firmware;
    gate: Gate;
    activity: Activity;
  },
) {
  const { devices, pairing, gate } = options;
  const record = options.activity.for("devices");

  // The actor for one of these calls. A refusal goes to the activity log
  // with the person and client behind it.
  function admitted(principal: Principal, rule: Rule, action: string) {
    const who = {
      personId: principal.person?.id,
      clientId: principal.client.id,
    };
    try {
      return { actor: gate.admit(principal, rule), who };
    } catch (error) {
      if (error instanceof ActionCallError) {
        record({ action, outcome: "refused", reason: error.code, ...who });
      }
      throw error;
    }
  }

  app.get("/api/devices", async (request): Promise<DeviceInfo[]> => {
    gate.admit(request.principal!, { tier: "read" });
    return devicesForPage(request, devices.list());
  });

  app.post("/api/devices/command", async (request): Promise<CapabilityInfo> => {
    // From an app's page, only a kind its app controls.
    if (request.pageApp) {
      const { device, capability } = (request.body ?? {}) as {
        device?: unknown;
        capability?: unknown;
      };
      try {
        commandFromPage(
          request,
          typeof device === "string"
            ? devices
                .get(device)
                ?.capabilities.find((each) => each.id === capability)?.kind
            : undefined,
        );
      } catch (error) {
        if (error instanceof ActionCallError) {
          record({
            action: "device.command",
            outcome: "refused",
            reason: error.code,
            ...changedBy(request.principal!),
            app: request.pageApp.app,
            subjectId: typeof device === "string" ? device : undefined,
          });
        }
        throw error;
      }
    }
    return devices.commandFor(request.principal!, request.body);
  });

  app.post("/api/devices/lights", async (request): Promise<LightsResult> => {
    // From an app's page, only while its app controls lights.
    commandFromPage(request, "light");
    return options.lights.switchFor(request.principal!, request.body);
  });

  app.post(
    "/api/devices/update",
    async (request: FastifyRequest): Promise<DeviceInfo> =>
      devices.update(changedBy(request.principal!), request.body),
  );

  app.post("/api/devices/remove", async (request) => {
    const { actor, who } = admitted(
      request.principal!,
      removalRule,
      "device.remove",
    );
    await devices.remove(actor, who, request.body);
    return { id: (request.body as { id: string }).id };
  });

  app.post(
    "/api/devices/capture/start",
    async (request): Promise<PressCapture> =>
      options.presses.capture(request.body, request.principal!.client.id),
  );

  app.post("/api/devices/capture/stop", async (request, reply) => {
    options.presses.stopCapture(request.body, request.principal!.client.id);
    return reply.code(204).send();
  });

  for (const hook of ["check", "update", "stop"] as const) {
    app.post(
      `/api/devices/firmware/${hook}`,
      async (request): Promise<DeviceInfo> => {
        const { actor, who } = admitted(
          request.principal!,
          firmwareRules[hook],
          `device.firmware.${hook}`,
        );
        return options.firmware[hook](actor, who, request.body);
      },
    );
  }

  app.post("/api/devices/probe", async (request): Promise<ProbeResult> => {
    const { actor, who } = admitted(
      request.principal!,
      firmwareRules.probe,
      "device.probe",
    );
    return options.firmware.probe(actor, who, request.body);
  });

  app.get("/api/devices/pairing", async (request): Promise<PairingInfo> => {
    gate.admit(request.principal!, pairingRules.read);
    return pairing.info();
  });

  app.post("/api/devices/pairing/open", async (request) => {
    const { actor, who } = admitted(
      request.principal!,
      pairingRules.change,
      "pairing.open",
    );
    return pairing.open(actor, who, request.body);
  });

  app.post(
    "/api/devices/pairing/close",
    async (request): Promise<PairingInfo> => {
      const { actor, who } = admitted(
        request.principal!,
        pairingRules.change,
        "pairing.close",
      );
      return pairing.close(actor, who);
    },
  );
}

import { ActionError, defineAction } from "@meetsanctum/app-sdk";
import { z } from "zod";

import type { DeviceFacts } from "./facts.js";

// What a device's page asks the app: how the device was reached, what it
// runs and its signal, as its connection last told them.

const deviceFacts = z.object({
  address: z.string(),
  encrypted: z.boolean(),
  version: z.string().nullable(),
  signal: z.number().nullable(),
  unused: z.array(z.string()),
  sleeps: z.boolean(),
});

export function deviceAction(
  facts: (deviceId: string) => Promise<DeviceFacts | null>,
) {
  return defineAction({
    id: "esphome.device",
    title: "Device",
    tier: "read",
    input: z.object({ device: z.string() }),
    output: deviceFacts,
    async run(_ctx, input) {
      const found = await facts(input.device);
      if (!found) throw new ActionError("not_found", "No such device");
      return found;
    },
  });
}

export type DeviceAction = ReturnType<typeof deviceAction>;

import { deviceTypeId } from "@meetsanctum/app-sdk";
import { z } from "zod";

// What a client asks of Devices: to rename a device, move it to another
// room or show it as another type, and to command one of its capabilities.

export const deviceChanges = z.object({
  id: z.string().min(1).max(64),
  // None names it after its room again.
  name: z.string().trim().min(1).max(120).nullable().optional(),
  roomId: z.string().min(1).max(64).nullable().optional(),
  // A type its own type may be shown as; none shows it as what it is again.
  shownAs: deviceTypeId.nullable().optional(),
});

export const commandRequest = z.object({
  device: z.string().min(1).max(64),
  capability: z.string().min(1).max(32),
  command: z.unknown(),
});

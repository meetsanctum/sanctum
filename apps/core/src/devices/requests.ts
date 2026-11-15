import { z } from "zod";

// What a client asks of Devices: to rename a device or move it to another
// room, and to command one of its capabilities.

export const deviceChanges = z.object({
  id: z.string().min(1).max(64),
  // None names it after its room again.
  name: z.string().trim().min(1).max(120).nullable().optional(),
  roomId: z.string().min(1).max(64).nullable().optional(),
});

export const commandRequest = z.object({
  device: z.string().min(1).max(64),
  capability: z.string().min(1).max(32),
  command: z.unknown(),
});

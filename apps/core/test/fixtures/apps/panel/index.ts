import { defineAction, defineApp } from "@meetsanctum/app-sdk";
import { z } from "zod";

// An app that uses lights, like a bare Moods, for the tests: it reads places
// and lights, and switches lights. It may read and control lights only, so
// switches stay out of its sight.

const overview = defineAction({
  id: "panel.overview",
  title: "Home overview",
  tier: "read",
  input: z.object({}),
  output: z.unknown(),
  async run(ctx) {
    const places = await ctx.places.list();
    const devices = await ctx.devices.list();
    return { home: places.home.name, rooms: places.rooms, devices };
  },
});

const show = defineAction({
  id: "panel.show",
  title: "One device",
  tier: "read",
  input: z.object({ device: z.string() }),
  output: z.unknown(),
  async run(ctx, input) {
    return ctx.devices.state(input.device);
  },
});

// Whatever a caller asks for, so tests can try what the core refuses.
const command = defineAction({
  id: "panel.command",
  title: "Command a device",
  tier: "write",
  input: z.object({
    device: z.string(),
    capability: z.string(),
    command: z.unknown(),
  }),
  output: z.unknown(),
  async run(ctx, input) {
    return ctx.devices.command(input);
  },
});

export default defineApp({
  id: "test.panel",
  name: "Panel",
  version: "0.1.0",
  core: "^1.0.0",
  permissions: [
    { id: "places.read", reason: "For the test." },
    { id: "devices.read:light", reason: "For the test." },
    { id: "devices.control:light", reason: "For the test." },
  ],
  actions: [overview, show, command],
  events: [],
});

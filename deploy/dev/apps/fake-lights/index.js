import { defineApp, light as lightKind } from "@meetsanctum/app-sdk";

// Pretend lights and contact sensors for a development stack, since a Mac
// has no Zigbee stick: a driver app like Zigbee, whose lights do what they're
// told at once and whose contact sensors open and close by themselves. It
// ships with no host: only a development stack stages it
// (deploy/dev/stack.Dockerfile).

const lights = new Map(
  [
    ["floor", "Floor lamp"],
    ["shelf", "Shelf light"],
    ["desk", "Desk lamp"],
    ["bedside", "Bedside lamp"],
  ].map(([key, name]) => [
    key,
    {
      name,
      state: {
        on: false,
        brightness: 100,
        colorMode: "temperature",
        colorTemperature: 370,
      },
    },
  ]),
);

// A door that opens for half a minute every few minutes, and a window that
// stays open for ten minutes of every half hour, so a home shows both a
// sensor that has just opened and one open for a while.
const minute = 60_000;
const contacts = new Map([
  [
    "balcony-door",
    { name: "Balcony door", every: 3 * minute, openFor: 30_000 },
  ],
  [
    "bedroom-window",
    { name: "Bedroom window", every: 30 * minute, openFor: 10 * minute },
  ],
]);

// Whether a contact is open now, by the clock: open at the start of each of
// its periods.
const isOpen = ({ every, openFor }, now = Date.now()) => now % every < openFor;

const reportContact = (ctx, key) =>
  ctx.devices.report({
    key,
    availability: "online",
    states: { contact: { open: isOpen(contacts.get(key)) } },
    battery: 87,
  });

let ticking;

const report = (ctx, key) =>
  ctx.devices.report({
    key,
    availability: "online",
    states: { light: lights.get(key).state },
  });

export default defineApp({
  id: "sanctum.fake-lights",
  name: "Fake lights",
  version: "0.1.0",
  core: "^1.0.0",
  permissions: [
    {
      id: "devices.register",
      reason:
        "To bring pretend lights and contact sensors into a development home.",
      needed: true,
    },
  ],
  actions: [],
  events: [],
  async start(ctx) {
    for (const [key, { name }] of lights) {
      await ctx.devices.register({
        key,
        name,
        manufacturer: "Sanctum",
        model: "Fake light",
        capabilities: [
          {
            id: "light",
            kind: "light",
            features: {
              brightness: true,
              colorTemperature: { min: 153, max: 500 },
              color: true,
            },
          },
        ],
      });
      await report(ctx, key);
    }
    for (const [key, { name }] of contacts) {
      await ctx.devices.register({
        key,
        name,
        manufacturer: "Sanctum",
        model: "Fake contact sensor",
        capabilities: [{ id: "contact", kind: "contact" }],
      });
      await reportContact(ctx, key);
    }
    await ctx.devices.present({ keys: [...lights.keys(), ...contacts.keys()] });
    // The core takes a report that says the same again as no change.
    ticking = setInterval(() => {
      for (const key of contacts.keys()) {
        void reportContact(ctx, key).catch(() => undefined);
      }
    }, 10_000);
  },
  async stop() {
    clearInterval(ticking);
  },
  driver: {
    async command(ctx, command) {
      const light = lights.get(command.key);
      // A contact sensor takes no commands, and the core sends it none.
      if (!light) return;
      light.state = { ...light.state, ...lightKind.desired(command.command) };
      await report(ctx, command.key);
    },
  },
});

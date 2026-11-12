import { defineApp, light as lightKind } from "@meetsanctum/app-sdk";

// Pretend lights for a development stack, since a Mac has no Zigbee stick: a
// driver app like Zigbee, whose lights do what they're told at once. It ships
// with no host: only a development stack stages it (deploy/dev/stack.Dockerfile).

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
      reason: "To bring pretend lights into a development home.",
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
    await ctx.devices.present({ keys: [...lights.keys()] });
  },
  driver: {
    async command(ctx, command) {
      const light = lights.get(command.key);
      light.state = { ...light.state, ...lightKind.desired(command.command) };
      await report(ctx, command.key);
    },
  },
});

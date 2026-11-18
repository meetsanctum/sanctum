import { defineApp, light as lightKind } from "@meetsanctum/app-sdk";

// Pretend lights and contact sensors for a development stack, since a Mac
// has no Zigbee stick: a driver app like Zigbee, whose lights do what they're
// told at once and whose contact sensors open and close by themselves. Add
// devices can try it out: while it lets devices join, a new light joins a few
// seconds in and another a little later, and it has found a sensor and a plug
// on the network, the plug asking for its key ("sanctum"). It ships with no
// host: only a development stack stages it (deploy/dev/stack.Dockerfile).

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
// The context of its run, which lasts until it stops, for what happens
// after a call has answered, such as a light joining.
let running;

// What it has found and could add, until someone adds it.
const found = new Map([
  [
    "office-air",
    {
      key: "office-air",
      name: "Office Air",
      description: "Temperature, humidity",
      type: null,
      asks: [],
    },
  ],
  [
    "desk-plug",
    {
      key: "desk-plug",
      name: "Desk Plug",
      description: "Needs its key",
      type: null,
      asks: ["key"],
    },
  ],
]);

// Lights that join while it lets devices join: the first a few seconds in,
// the next a little later, each joining, being set up, then ready. Only a
// light whose time comes while devices may join starts joining; one that
// has started finishes, even once they no longer may.
let starts = [];
let steps = [];
let joined = 0;

function joinLight(ctx, after, until) {
  if (Date.now() + after >= until) return;
  starts.push(
    setTimeout(() => {
      // A timer that fires late, after the window, starts nothing.
      if (Date.now() >= until) return;
      const number = ++joined;
      const key = `new-light-${number}`;
      const stages = [
        [0, () => ctx.devices.joining({ key, stage: "joined" })],
        [
          1_500,
          () =>
            ctx.devices.joining({
              key,
              stage: "interviewing",
              description: "Fake light",
            }),
        ],
        [
          3_500,
          async () => {
            lights.set(key, {
              name: `Fake light ${number}`,
              state: {
                on: true,
                brightness: 100,
                colorMode: "temperature",
                colorTemperature: 370,
              },
            });
            await registerLight(ctx, key);
            await report(ctx, key);
            await ctx.devices.joining({
              key,
              stage: "ready",
              description: "Fake light",
            });
          },
        ],
      ];
      for (const [at, stage] of stages) {
        steps.push(setTimeout(() => void stage().catch(() => undefined), at));
      }
    }, after),
  );
}

// Lights not yet joining don't; those joining finish.
function stopStarts() {
  starts.forEach(clearTimeout);
  starts = [];
}

const registerLight = (ctx, key) =>
  ctx.devices.register({
    key,
    name: lights.get(key).name,
    manufacturer: "Sanctum",
    model: "Fake light",
    // It blinks to show itself (Blink).
    identify: true,
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
    running = ctx;
    for (const key of lights.keys()) {
      await registerLight(ctx, key);
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
    await ctx.devices.found([...found.values()]);
    // The core takes a report that says the same again as no change.
    ticking = setInterval(() => {
      for (const key of contacts.keys()) {
        void reportContact(ctx, key).catch(() => undefined);
      }
    }, 10_000);
  },
  async stop() {
    clearInterval(ticking);
    stopStarts();
    steps.forEach(clearTimeout);
    steps = [];
  },
  driver: {
    async command(ctx, command) {
      const light = lights.get(command.key);
      // A contact sensor takes no commands, and the core sends it none.
      if (!light) return;
      light.state = { ...light.state, ...lightKind.desired(command.command) };
      await report(ctx, command.key);
    },
    // Blinks: off and on again three times, then as it was.
    async identify(ctx, { key }) {
      const light = lights.get(key);
      if (!light) return;
      const was = light.state;
      for (let flash = 0; flash < 6; flash += 1) {
        setTimeout(() => {
          light.state = flash === 5 ? was : { ...was, on: flash % 2 === 1 };
          void report(ctx, key).catch(() => undefined);
        }, flash * 300);
      }
    },
    pairing: {
      async open(_ctx, { seconds }) {
        stopStarts();
        const until = Date.now() + seconds * 1000;
        joinLight(running, 5_000, until);
        joinLight(running, 9_000, until);
        return { until: new Date(until).toISOString() };
      },
      async close() {
        stopStarts();
      },
    },
    questions: {
      key: {
        label: "Key",
        kind: "secret",
        help: "Whoever set the plug up has it.",
        refusals: {
          wrongKey: "That key doesn't match. Check it and try again.",
        },
      },
    },
    async add(ctx, { key, answers }) {
      const device = found.get(key);
      if (!device) return;
      if (device.asks.includes("key") && answers.key !== "sanctum") {
        return { refused: { question: "key", refusal: "wrongKey" } };
      }
      await ctx.devices.register({
        key,
        name: device.name,
        manufacturer: "Sanctum",
        model: "Fake sensor",
        capabilities: [{ id: "contact", kind: "contact" }],
      });
      await ctx.devices.report({
        key,
        availability: "online",
        states: { contact: { open: false } },
      });
      found.delete(key);
      await ctx.devices.found([...found.values()]);
    },
  },
});

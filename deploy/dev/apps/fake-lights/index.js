import {
  defineApp,
  light as lightKind,
  media as mediaKind,
  switchCapability,
} from "@meetsanctum/app-sdk";

// Pretend lights, contact sensors and media players for a development
// stack, since a Mac has no Zigbee stick: a driver app like Zigbee, whose
// lights and players do what they're told at once and whose contact sensors
// open and close by themselves. Add
// devices can try it out: while it lets devices join, a new light joins a few
// seconds in and another a little later, and it has found a climate sensor
// and a plug on the network, the plug asking for its key ("sanctum"). Only
// a development stack stages it (deploy/dev/stack.Dockerfile).

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

// A TV box playing a show, which turns on and off and steps the TV's volume,
// and a smart speaker with nothing on, its volume a level it can mute.
const players = new Map([
  [
    "tv-box",
    {
      name: "Living room box",
      type: "media-player",
      features: {
        power: true,
        playback: ["play", "pause", "stop", "next", "previous", "seek"],
        volume: "steps",
      },
      state: {
        on: true,
        activity: "playing",
        app: { id: "tv.example", name: "TV" },
        media: {
          title: "The Long Way Round",
          series: "The Long Way Round",
          season: 2,
          episode: 4,
          type: "episode",
          duration: 2700,
          position: 1032,
          positionAt: new Date().toISOString(),
        },
      },
    },
  ],
  [
    "office-speaker",
    {
      name: "Office speaker",
      type: "smart-speaker",
      features: {
        playback: ["play", "pause", "stop"],
        volume: "level",
        mute: true,
      },
      state: { activity: "idle", volume: 40, muted: false },
    },
  ],
]);

const reportPlayer = (ctx, key) =>
  ctx.devices.report({
    key,
    availability: "online",
    states: { player: players.get(key).state },
  });

// What a player does with a command: what it asked for, a position counted
// from now, a step of 5, and nothing playing once it stops or turns off.
function play(player, command) {
  const state = { ...player.state, ...mediaKind.desired(command) };
  const media = state.media && {
    ...state.media,
    position: playedTo(state.media, player.state.activity === "playing"),
    positionAt: new Date().toISOString(),
  };
  if (media) state.media = media;
  if ("position" in command && media) media.position = command.position;
  if ("volumeStep" in command && state.volume !== undefined) {
    const by = command.volumeStep === "up" ? 5 : -5;
    state.volume = Math.max(0, Math.min(100, state.volume + by));
  }
  if (command.playback === "stop" || command.on === false) {
    state.activity = "idle";
  }
  if (command.on === true && player.state.on === false) {
    state.activity = "paused";
  }
  player.state = state;
}

// Where it has got to in what it plays.
const playedTo = (media, playing) =>
  playing
    ? Math.min(
        media.duration,
        media.position + (Date.now() - Date.parse(media.positionAt)) / 1000,
      )
    : media.position;

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

// A blink keeps its original state until it finishes or a command ends it.
const blinking = new Map();

function stopBlink(key) {
  const blink = blinking.get(key);
  if (!blink) return;
  blink.timers.forEach(clearTimeout);
  lights.get(key).state = blink.was;
  blinking.delete(key);
}

// What it has found and could add, until someone adds it: what each is,
// what adding it asks, and what it has and first says once added.
const foundDevices = [
  {
    key: "office-air",
    name: "Office Air",
    description: "Temperature, humidity",
    type: "sensor",
    asks: [],
    model: "Fake climate sensor",
    capabilities: [
      {
        id: "temperature",
        kind: "sensor",
        features: { measures: "temperature" },
      },
      { id: "humidity", kind: "sensor", features: { measures: "humidity" } },
    ],
    states: { temperature: { value: 22.5 }, humidity: { value: 45 } },
  },
  {
    key: "desk-plug",
    name: "Desk Plug",
    description: "Needs its key",
    type: "plug",
    asks: ["key"],
    model: "Fake plug",
    capabilities: [{ id: "power", kind: "switch" }],
    states: { power: { on: false } },
  },
];
const added = new Set();
// What it lists of each found device (ctx.devices.found).
const listed = () =>
  foundDevices
    .filter(({ key }) => !added.has(key))
    .map(({ key, name, description, type, asks }) => ({
      key,
      name,
      description,
      type,
      asks,
    }));

async function registerFound(
  ctx,
  { key, name, model, type, capabilities, states },
) {
  await ctx.devices.register({
    key,
    name,
    manufacturer: "Sanctum",
    model,
    type,
    capabilities,
  });
  added.add(key);
  await ctx.devices.report({ key, availability: "online", states });
}

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
    type: "light",
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
  core: "^2.0.0",
  permissions: [
    {
      id: "devices.register",
      reason:
        "To bring pretend lights, sensors and a plug into a development home.",
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
        type: "contact",
        capabilities: [{ id: "contact", kind: "contact" }],
      });
      await reportContact(ctx, key);
    }
    for (const [key, { name, type, features }] of players) {
      await ctx.devices.register({
        key,
        name,
        manufacturer: "Sanctum",
        model: "Fake media player",
        type,
        capabilities: [{ id: "player", kind: "media", features }],
      });
      await reportPlayer(ctx, key);
    }
    const previouslyAdded = new Set(
      (await ctx.devices.list())
        .filter((device) => device.driver === ctx.appId)
        .map((device) => device.key),
    );
    added.clear();
    for (const device of foundDevices) {
      if (previouslyAdded.has(device.key)) await registerFound(ctx, device);
    }
    await ctx.devices.present({
      keys: [...lights.keys(), ...contacts.keys(), ...players.keys(), ...added],
    });
    await ctx.devices.found(listed());
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
    for (const key of blinking.keys()) stopBlink(key);
    running = undefined;
  },
  driver: {
    async command(ctx, command) {
      if (command.kind === "switch" && added.has(command.key)) {
        await ctx.devices.report({
          key: command.key,
          availability: "online",
          states: { power: switchCapability.desired(command.command) },
        });
        return;
      }
      const player = players.get(command.key);
      if (command.kind === "media" && player) {
        play(player, command.command);
        await reportPlayer(ctx, command.key);
        return;
      }
      const light = lights.get(command.key);
      // A sensor takes no commands, and the core sends it none.
      if (!light) return;
      stopBlink(command.key);
      light.state = { ...light.state, ...lightKind.desired(command.command) };
      await report(ctx, command.key);
    },
    // Blinks: off and on again three times, then as it was.
    async identify(_ctx, { key }) {
      const light = lights.get(key);
      const ctx = running;
      if (!light || !ctx) return;
      stopBlink(key);
      const blink = { was: light.state, timers: [] };
      blinking.set(key, blink);
      for (let flash = 0; flash < 6; flash += 1) {
        blink.timers.push(
          setTimeout(() => {
            const { was } = blink;
            light.state = flash % 2 === 0 ? { ...was, on: !was.on } : was;
            if (flash === 5) blinking.delete(key);
            void report(ctx, key).catch(() => undefined);
          }, flash * 300),
        );
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
      const device = foundDevices.find((each) => each.key === key);
      if (!device) return;
      if (device.asks.includes("key") && answers.key !== "sanctum") {
        return { refused: { question: "key", refusal: "wrongKey" } };
      }
      await registerFound(ctx, device);
      await ctx.devices.found(listed());
    },
  },
});

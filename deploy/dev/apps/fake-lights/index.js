import {
  defineApp,
  light as lightKind,
  media as mediaKind,
  switchCapability,
} from "@meetsanctum/app-sdk";
import { crc32, deflateSync } from "node:zlib";

import { createPairing } from "./pairing.js";
import {
  climateOf,
  climateSensors,
  contactSensors,
  isOpen,
  lightNames,
  motionSensors,
  playerNames,
  plugNames,
  seesMotion,
} from "./home.js";

// A pretend home's devices for a development stack, since a Mac has no
// Zigbee stick: a driver app like Zigbee, whose lights, plugs and players do
// what they're told at once, and whose contact, motion and climate sensors
// change by themselves (home.js). Add
// devices can try it out: while it lets devices join, a new light joins a few
// seconds in and another a little later, and it has found a climate sensor
// and a plug on the network, the plug asking for its key ("sanctum"), and a
// TV box that asks two codes once adding starts (pairing.js). Once added,
// the TV box starts each later run with its pairing lost, as a box reset
// while its driver was away, and Repair sets it right with the same two
// codes. Only a development stack stages it (deploy/dev/stack.Dockerfile).

const lights = new Map(
  lightNames.map(([key, name]) => [
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
const plugs = new Map(
  plugNames.map(([key, name]) => [key, { name, state: { on: false } }]),
);
const contacts = new Map(contactSensors.map((each) => [each.key, each]));

// A TV box playing a show, which turns on and off and steps the TV's volume,
// and a smart speaker with nothing on, its volume a level it can mute.
const players = new Map([
  [
    "tv-box",
    {
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
      type: "smart-speaker",
      features: {
        playback: ["play", "pause", "stop"],
        volume: "level",
        mute: true,
      },
      state: { activity: "idle", volume: 40, muted: false },
      // A smart speaker has microphones, which it mutes when asked.
      microphones: { muted: false },
    },
  ],
]);

// A player says what it plays with a picture of it, as a driver hands one
// over: the TV box draws one for each episode, in a colour of its own, so
// the detail's picture and the veil's colour change as it skips. Every
// fifth episode's says it is far larger than the core keeps, so the core
// refuses it and the player says what it plays without a picture.
async function reportPlayer(ctx, key, refreshArtwork = false) {
  const player = players.get(key);
  const state = player.state;
  const { media } = state;
  if (
    media?.episode !== undefined &&
    (refreshArtwork || !media.artwork) &&
    ctx.actor.kind !== "assistant-run"
  ) {
    try {
      const { hash } = await ctx.blobs.put({
        type: "image/png",
        data: episodePicture(media.episode),
      });
      state.media = { ...media, artwork: hash };
    } catch (error) {
      const withoutArtwork = { ...media };
      delete withoutArtwork.artwork;
      state.media = withoutArtwork;
      ctx.log(`episode ${media.episode}'s picture was refused: ${error}`);
    }
  }
  // Another command may have reported a newer state while the upload ran.
  if (player.state !== state) return;
  await ctx.devices.report({
    key,
    availability: "online",
    states: { player: state },
  });
}

// A 16:9 picture with a soft gradient, its hue by the episode; every fifth
// says it is 8000 by 4500 px.
function episodePicture(episode) {
  const width = 160;
  const height = 90;
  const hue = (episode * 67) % 360;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    const row = [0];
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = rgbOf(
        hue + (x / width) * 40,
        0.55,
        0.25 + (y / height) * 0.3,
      );
      row.push(r, g, b);
    }
    rows.push(...row);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  const oversized = episode % 5 === 0;
  header.writeUInt32BE(oversized ? 8000 : width, 0);
  header.writeUInt32BE(oversized ? 4500 : height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Uint8Array.from(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(Buffer.from(rows))),
      chunk("IEND", Buffer.alloc(0)),
    ]),
  );
}

// HSL to 8-bit RGB.
function rgbOf(hue, saturation, lightness) {
  const k = (n) => (n + hue / 30) % 12;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const f = (n) =>
    lightness - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0), f(8), f(4)].map((each) => Math.round(each * 255));
}

// What a player does with a command: set what it asked for, seek or change
// episodes, step the volume by 5, or go idle once it stops or turns off.
function play(player, command) {
  const state = { ...player.state, ...mediaKind.desired(command) };
  const media = state.media && {
    ...state.media,
    position: playedTo(state.media, player.state.activity === "playing"),
    positionAt: new Date().toISOString(),
  };
  if (media) state.media = media;
  if ("position" in command && media) media.position = command.position;
  if (
    media?.episode !== undefined &&
    ["next", "previous"].includes(command.playback)
  ) {
    const step = command.playback === "next" ? 1 : -1;
    const episode = Math.max(1, Math.min(100_000, media.episode + step));
    if (episode !== media.episode) delete media.artwork;
    media.episode = episode;
    media.position = 0;
  }
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
        media.position +
          Math.max(0, Date.now() - Date.parse(media.positionAt)) / 1000,
      )
    : media.position;

const contactReading = (key) => ({
  key,
  availability: "online",
  states: { contact: { open: isOpen(contacts.get(key)) } },
  battery: 87,
});

const motionReading = (sensor) => ({
  key: sensor.key,
  availability: "online",
  states: { occupancy: { motion: seesMotion(sensor) } },
  battery: 74,
});

function climateReading(sensor) {
  const { temperature, humidity } = climateOf(sensor);
  return {
    key: sensor.key,
    availability: "online",
    states: {
      temperature: { value: temperature },
      humidity: { value: humidity },
    },
    battery: 91,
  };
}

const reportPlug = (ctx, key) =>
  ctx.devices.report({
    key,
    availability: "online",
    states: { power: plugs.get(key).state },
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
// The TV box pairs once adding starts, asking each code as the box shows it.
const tvBox = {
  key: "den-tv",
  name: "Den TV",
  description: "Fake TV box",
  type: "media-player",
  asks: [],
  model: "Fake TV box",
  capabilities: [
    {
      id: "player",
      kind: "media",
      features: { power: true, playback: ["play", "pause"], volume: "steps" },
    },
  ],
  states: { player: { on: false, activity: "idle" } },
};
foundDevices.push(tvBox);
const pairing = createPairing();
// Whether the TV box is paired this run: once added, not until repaired.
let tvPaired = false;
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
  // The TV box plays as the other players do once it's added.
  if (key === tvBox.key) {
    players.set(key, {
      type,
      features: capabilities[0].features,
      state: { ...states.player },
    });
  }
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
    const reported = new Map();
    const reporting = new Set();
    async function reportSensor(reading) {
      const { key, states } = reading;
      const value = JSON.stringify(states);
      if (reported.get(key) === value || reporting.has(key)) return;
      reporting.add(key);
      try {
        await ctx.devices.report(reading);
        reported.set(key, value);
      } finally {
        reporting.delete(key);
      }
    }
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
      await reportSensor(contactReading(key));
    }
    for (const sensor of motionSensors) {
      await ctx.devices.register({
        key: sensor.key,
        name: sensor.name,
        manufacturer: "Sanctum",
        model: "Fake motion sensor",
        type: "motion",
        capabilities: [
          {
            id: "occupancy",
            kind: "motion",
            features: { sensitivity: null, clearAfter: null, indicator: false },
          },
        ],
      });
      await reportSensor(motionReading(sensor));
    }
    for (const sensor of climateSensors) {
      await ctx.devices.register({
        key: sensor.key,
        name: sensor.name,
        manufacturer: "Sanctum",
        model: "Fake climate sensor",
        type: "sensor",
        capabilities: [
          {
            id: "temperature",
            kind: "sensor",
            features: { measures: "temperature" },
          },
          {
            id: "humidity",
            kind: "sensor",
            features: { measures: "humidity" },
          },
        ],
      });
      await reportSensor(climateReading(sensor));
    }
    for (const [key, { name }] of plugs) {
      await ctx.devices.register({
        key,
        name,
        manufacturer: "Sanctum",
        model: "Fake plug",
        type: "plug",
        capabilities: [{ id: "power", kind: "switch" }],
      });
      await reportPlug(ctx, key);
    }
    for (const [key, name] of playerNames) {
      const { type, features, microphones } = players.get(key);
      await ctx.devices.register({
        key,
        name,
        manufacturer: "Sanctum",
        model: "Fake media player",
        type,
        capabilities: [
          { id: "player", kind: "media", features },
          ...(microphones
            ? [{ id: "microphones", kind: "audio", features: { mutes: true } }]
            : []),
        ],
      });
      await reportPlayer(ctx, key, true);
      if (microphones) {
        await ctx.devices.report({ key, states: { microphones } });
      }
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
      keys: [
        ...new Set([
          ...lights.keys(),
          ...plugs.keys(),
          ...contacts.keys(),
          ...motionSensors.map((each) => each.key),
          ...climateSensors.map((each) => each.key),
          ...players.keys(),
          ...added,
        ]),
      ],
    });
    tvPaired = !added.has(tvBox.key);
    if (!tvPaired) {
      await ctx.devices.problem({ key: tvBox.key, problem: "pairingLost" });
    }
    await ctx.devices.found(listed());
    // Each report updates the device's last-seen time, so only send changes.
    ticking = setInterval(() => {
      for (const key of contacts.keys()) {
        void reportSensor(contactReading(key)).catch(() => undefined);
      }
      for (const sensor of motionSensors) {
        void reportSensor(motionReading(sensor)).catch(() => undefined);
      }
      for (const sensor of climateSensors) {
        void reportSensor(climateReading(sensor)).catch(() => undefined);
      }
    }, 5_000);
  },
  async stop() {
    clearInterval(ticking);
    stopStarts();
    steps.forEach(clearTimeout);
    steps = [];
    for (const key of blinking.keys()) stopBlink(key);
    pairing.clear();
    running = undefined;
  },
  driver: {
    async command(ctx, command) {
      const plug = plugs.get(command.key);
      if (command.kind === "switch" && plug) {
        plug.state = {
          ...plug.state,
          ...switchCapability.desired(command.command),
        };
        await reportPlug(ctx, command.key);
        return;
      }
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
      if (command.kind === "audio" && player?.microphones) {
        player.microphones = { muted: command.command.muted };
        await ctx.devices.report({
          key: command.key,
          states: { microphones: player.microphones },
        });
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
      firstCode: {
        label: "Code on the TV",
        kind: "code",
        length: 4,
        help: "The TV shows a four-digit code. Any but 0000 works here.",
        refusals: { wrongCode: "That code didn't match." },
      },
      secondCode: {
        label: "Code on the TV",
        kind: "code",
        length: 4,
        help: "A new code is on the TV.",
        lasts: { seconds: 35, again: "Show a new code" },
        refusals: { wrongCode: "That code didn't match." },
      },
    },
    addLater: ["firstCode", "secondCode"],
    addLaterInOrder: true,
    problems: {
      pairingLost: {
        words: "Its pairing was removed",
        repair: {
          help: "Pair it again. The TV shows two codes, one after the other.",
          asks: [],
          later: ["firstCode", "secondCode"],
        },
      },
    },
    async add(ctx, { key, answers, attempt, again }) {
      const device = foundDevices.find((each) => each.key === key);
      if (!device) return;
      if (device.asks.includes("key") && answers.key !== "sanctum") {
        return { refused: { question: "key", refusal: "wrongKey" } };
      }
      if (device === tvBox) {
        const step = pairing.step(key, { answers, attempt, again });
        if (step !== "paired") return step;
        tvPaired = true;
      }
      await registerFound(ctx, device);
      await ctx.devices.found(listed());
    },
    async cancelAdd(_ctx, { key, attempt }) {
      pairing.cancel(key, attempt);
    },
    async repair(ctx, { key, answers, attempt, again }) {
      if (key !== tvBox.key || tvPaired) return;
      const step = pairing.step(key, { answers, attempt, again });
      if (step !== "paired") return step;
      tvPaired = true;
      await ctx.devices.problem({ key, problem: null });
    },
    async cancelRepair(_ctx, { key, attempt }) {
      pairing.cancel(key, attempt);
    },
  },
});

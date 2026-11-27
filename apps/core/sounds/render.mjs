// Renders Cuelume's press theme success and error cues, as play() sounds them
// at its normal emphasis and full volume, into the 22,050 Hz, 16-bit mono WAV
// files beside this script. Cuelume synthesizes its cues with Web Audio, so
// they are rendered once offline and kept as files: the core has no Web
// Audio, and a smart speaker only plays a file.
//
// Run it from a folder with its two packages installed, as README.md says:
//   npm install cuelume@0.2.10 node-web-audio-api@2.3.0
//   node <this folder>/render.mjs

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// The packages come from the folder it runs in, not from beside this script.
const require = createRequire(join(process.cwd(), "render.mjs"));
const cuelume = dirname(require.resolve("cuelume/package.json"));
// Cuelume's renderer isn't among its exports, so it's loaded by its path.
const load = (path) => import(pathToFileURL(join(cuelume, "dist", path)).href);
const { OfflineAudioContext } = await import(
  pathToFileURL(require.resolve("node-web-audio-api")).href
);
const { createOutput } = await load("audio/output.js");
const { renderRecipe } = await load("audio/render.js");
const { shapeFor } = await load("sounds/context.js");
const { THEMES } = await load("sounds/themes.js");

// Noise layers start at a random point in Cuelume's noise: a fixed sequence
// renders the same files each time.
let seed = 1;
Math.random = () => {
  seed = (seed * 16_807) % 2_147_483_647;
  return (seed - 1) / 2_147_483_646;
};

const rate = 22_050;

for (const cue of ["success", "error"]) {
  const context = new OfflineAudioContext({
    numberOfChannels: 1,
    length: rate * 3,
    sampleRate: rate,
  });
  const recipe = THEMES.press[cue];
  const played = {
    recipe,
    volume: 1,
    emphasis: "normal",
    shape: shapeFor(cue, {}, "normal", Infinity),
    step: 0,
  };
  let bus;
  renderRecipe(
    context,
    () => (bus ??= createOutput(context)),
    new Map(),
    cue,
    played,
    "both",
  );
  const sound = (await context.startRendering()).getChannelData(0);

  // The ring ends where it falls 60 dB below its peak.
  const peak = sound.reduce(
    (most, value) => Math.max(most, Math.abs(value)),
    0,
  );
  let end = sound.length;
  while (end > 0 && Math.abs(sound[end - 1]) < peak / 1000) end--;

  const samples = Buffer.alloc(end * 2);
  for (let i = 0; i < end; i++) {
    const value = Math.max(-1, Math.min(1, sound[i]));
    samples.writeInt16LE(Math.round(value * 32_767), i * 2);
  }
  writeFileSync(join(here, `${cue}.wav`), wav(samples));
  console.log(`${cue}.wav: ${(end / rate).toFixed(2)} s`);
}
// Cuelume's own cleanup timers would keep it running a second longer.
process.exit(0);

function wav(samples) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + samples.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(samples.length, 40);
  return Buffer.concat([header, samples]);
}

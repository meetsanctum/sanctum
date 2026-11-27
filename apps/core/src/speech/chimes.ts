import { readFileSync } from "node:fs";

import type { SpeechAudio } from "./wyoming.js";

// The chimes a smart speaker plays in place of words: Cuelume's press theme
// success and error cues, rendered once into WAV files in the core's
// `sounds` folder, whose README says how. They are read once, as speech is
// assembled, and kept in memory.

export type Chime = "success" | "error";

/** A chime's sound, as `sounds/<chime>.wav` holds it. */
export function readChime(chime: Chime): SpeechAudio {
  return wavSound(
    readFileSync(new URL(`../../sounds/${chime}.wav`, import.meta.url)),
  );
}

/** The sound in a 16-bit mono PCM WAV file. */
export function wavSound(file: Buffer): SpeechAudio {
  if (
    file.toString("ascii", 0, 4) !== "RIFF" ||
    file.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error("Not a WAV file");
  }
  let rate: number | null = null;
  for (let at = 12; at + 8 <= file.length;) {
    const id = file.toString("ascii", at, at + 4);
    const size = file.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      const format = file.readUInt16LE(body);
      const channels = file.readUInt16LE(body + 2);
      const bits = file.readUInt16LE(body + 14);
      if (format !== 1 || channels !== 1 || bits !== 16) {
        throw new Error("A chime must be 16-bit mono PCM");
      }
      rate = file.readUInt32LE(body + 4);
    } else if (id === "data") {
      if (rate === null) throw new Error("A WAV file's format comes first");
      const count = Math.floor(Math.min(size, file.length - body) / 2);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i++) {
        samples[i] = file.readInt16LE(body + i * 2);
      }
      return { rate, samples };
    }
    // Chunks are padded to an even length.
    at = body + size + (size % 2);
  }
  throw new Error("A WAV file without sound");
}

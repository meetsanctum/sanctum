import { FLACDecoder } from "@wasm-audio-decoders/flac";
import { describe, expect, it } from "vitest";

import { createFlacEncoder } from "../src/speech/flac.js";

// Decoded by libFLAC (compiled to WebAssembly), which checks every frame's
// CRCs, so a stream that decodes to the same samples is a valid one. The
// frames go in one by one: the package's own frame finder skips a short
// final frame that libFLAC itself decodes.
async function decode(frames: Uint8Array[]) {
  const decoder = new FLACDecoder();
  await decoder.ready;
  const decoded = await decoder.decodeFrames(frames);
  decoder.free();
  return decoded;
}

function speechLike(length: number, rate: number) {
  const samples = new Int16Array(length);
  let seed = 7;
  for (let i = 0; i < length; i++) {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    const noise = (seed / 0x7fffffff - 0.5) * 2_000;
    const voice =
      Math.sin((2 * Math.PI * 180 * i) / rate) * 9_000 +
      Math.sin((2 * Math.PI * 720 * i) / rate) * 3_000;
    samples[i] = Math.max(-32_768, Math.min(32_767, Math.round(voice + noise)));
  }
  return samples;
}

function joined(parts: Uint8Array[]) {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** The stream as pushed in `pieces`, all of it in one go. */
function encode(samples: Int16Array, rate: number, pieces: number[]) {
  const encoder = createFlacEncoder(rate);
  const parts: Uint8Array[] = [];
  let at = 0;
  for (const size of pieces) {
    parts.push(encoder.push(samples.subarray(at, at + size)));
    at += size;
  }
  parts.push(encoder.push(samples.subarray(at)));
  parts.push(encoder.end());
  return joined(parts);
}

/** The stream's header and its frames, pushed a block at a time. */
function framesOf(samples: Int16Array, rate: number) {
  const encoder = createFlacEncoder(rate);
  const frames: Uint8Array[] = [];
  for (let at = 0; at < samples.length; at += 4_096) {
    const bytes = encoder.push(samples.subarray(at, Math.min(at + 4_096, samples.length)));
    if (bytes.length > 0) frames.push(bytes);
  }
  frames.push(encoder.end());
  const header = frames[0]!.subarray(0, 42);
  frames[0] = frames[0]!.subarray(42);
  return { header, frames: frames.filter((frame) => frame.length > 0) };
}

// The decoder gives floats with full scale at 1.0, so the loudest positive
// sample comes back as 32,768 and is clamped.
function toInt16(channel: Float32Array) {
  return Int16Array.from(channel, (value) =>
    Math.max(-32_768, Math.min(32_767, Math.round(value * 32_768))),
  );
}

describe("createFlacEncoder", () => {
  it("encodes speech-like sound that libFLAC decodes to the same samples", async () => {
    const samples = speechLike(22_050 * 2 + 1_234, 22_050);
    const { header, frames } = framesOf(samples, 22_050);
    const decoded = await decode(frames);
    expect(decoded.errors).toEqual([]);
    expect(decoded.sampleRate).toBe(22_050);
    expect(decoded.channelData).toHaveLength(1);
    expect(toInt16(decoded.channelData[0]!)).toEqual(samples);
    // However it arrives, the stream is the same.
    expect(encode(samples, 22_050, [1_000, 5_000, 333])).toEqual(joined([header, ...frames]));
    // Smaller than the same sound as 16-bit PCM.
    expect(joined(frames).length).toBeLessThan(samples.length * 2 * 0.8);
  });

  it("codes silence, full-scale steps and a last block of every short size", async () => {
    for (const length of [1, 2, 5, 255, 256, 257, 4_095, 4_096, 4_097, 10_000]) {
      const samples = new Int16Array(length);
      for (let i = 0; i < length && length !== 10_000; i++) {
        samples[i] = i % 3 === 0 ? 0 : i % 3 === 1 ? 32_767 : -32_768;
      }
      const decoded = await decode(framesOf(samples, 16_000).frames);
      expect(decoded.errors).toEqual([]);
      expect(decoded.sampleRate).toBe(16_000);
      expect(toInt16(decoded.channelData[0]!)).toEqual(samples);
    }
  });

  it("numbers frames past the one-byte range", async () => {
    const samples = speechLike(4_096 * 300 + 17, 22_050);
    const decoded = await decode(framesOf(samples, 22_050).frames);
    expect(decoded.errors).toEqual([]);
    expect(toInt16(decoded.channelData[0]!)).toEqual(samples);
  });

  it("starts with the stream's header before any block is complete", () => {
    const encoder = createFlacEncoder(22_050);
    const first = encoder.push(new Int16Array(10));
    expect(Array.from(first.subarray(0, 4))).toEqual([0x66, 0x4c, 0x61, 0x43]);
    expect(first).toHaveLength(42);
    expect(encoder.push(new Int16Array(10))).toHaveLength(0);
    expect(encoder.end().length).toBeGreaterThan(0);
    expect(() => encoder.push(new Int16Array(1))).toThrow();
  });
});

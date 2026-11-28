import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { readChime, wavSound } from "../src/speech/chimes.js";

// A smart speaker's chimes are Cuelume's press theme success and error cues,
// as sounds/render.mjs renders them from Cuelume 0.2.10: rendering them
// again changes these files only with Cuelume or the script.

const file = (chime: string) =>
  readFileSync(new URL(`../sounds/${chime}.wav`, import.meta.url));
const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

describe("smart speakers' chimes", () => {
  it("are Cuelume's press success and error cues as rendered", () => {
    expect(sha256(file("success"))).toBe(
      "dadc50d913cc236ea9f3222a61c1b7a38eadf930a287b229c4ce4119b68dd94e",
    );
    expect(sha256(file("error"))).toBe(
      "992350c400c97d63435e45fc345e1d4817086035fd5fa868f2b1ff681c0e3221",
    );
  });

  it.each([
    ["success", 1.52],
    ["error", 0.59],
  ] as const)(
    "reads %s as 22,050 Hz, 16-bit mono at Cuelume's own level",
    (chime, seconds) => {
      const { rate, samples } = readChime(chime);
      expect(rate).toBe(22_050);
      expect(samples.length / rate).toBeCloseTo(seconds, 2);
      const peak = samples.reduce(
        (most, sample) => Math.max(most, Math.abs(sample)),
        0,
      );
      // About the level the speakers' replies have played at: well clear of
      // clipping, as the core's other sounds.
      expect(peak).toBeGreaterThan(2_000);
      expect(peak).toBeLessThan(4_500);
    },
  );

  it("reads only 16-bit mono PCM", () => {
    const stereo = Buffer.from(file("error"));
    stereo.writeUInt16LE(2, 22);
    expect(() => wavSound(stereo)).toThrow("16-bit mono PCM");
    expect(() => wavSound(Buffer.from("not a wave file at all"))).toThrow(
      "Not a WAV file",
    );
  });

  it("rejects a format chunk cut off by the end of the WAV file", () => {
    const truncated = file("error").subarray(0, 35);
    expect(() => wavSound(truncated)).toThrow("Incomplete WAV format chunk");
  });

  it("rejects a WAV format chunk smaller than its required fields", () => {
    const shortFormat = file("error");
    shortFormat.writeUInt32LE(14, 16);
    expect(() => wavSound(shortFormat)).toThrow("Incomplete WAV format chunk");
  });
});

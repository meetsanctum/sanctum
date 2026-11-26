import { describe, expect, it } from "vitest";

import {
  formatPairingCode,
  newPairingSecret,
  normalisePairingCode,
  pairingCodeAlphabet,
  pairingQrText,
  parsePairingQr,
  splitPairingCode,
} from "../src/index.js";

describe("display codes", () => {
  it("are a lookup and a secret, eight characters without look-alikes", () => {
    for (let i = 0; i < 200; i += 1) {
      const lookup = "K7";
      const secret = newPairingSecret();
      expect(secret).toMatch(/^[2-9A-HJKMNP-TV-Z]{6}$/);
      const code = `${lookup}${secret}`;
      expect(normalisePairingCode(code)).toBe(code);
      expect(splitPairingCode(code)).toEqual({ lookup, secret });
    }
    expect(pairingCodeAlphabet).not.toMatch(/[01ILOU]/);
  });

  it("use every character of the alphabet", () => {
    const seen = new Set(
      Array.from({ length: 200 }, () => newPairingSecret()).join(""),
    );
    expect(seen.size).toBe(pairingCodeAlphabet.length);
  });

  it("show in two groups of four", () => {
    expect(formatPairingCode("K7QXM4PD")).toBe("K7QX-M4PD");
  });

  it("are read back however they were typed", () => {
    expect(normalisePairingCode("k7qx-m4pd")).toBe("K7QXM4PD");
    expect(normalisePairingCode(" K7QX M4PD ")).toBe("K7QXM4PD");
  });

  it.each([
    "K7QX-M4P",
    "K7QX-M4PDD",
    "K7QX-M4P0",
    "K7QX-M4PI",
    "K7QX_M4PD",
    "",
  ])("refuses %j", (value) => expect(normalisePairingCode(value)).toBeNull());
});

describe("the pairing QR code", () => {
  const hostId = "6b0f6f4e-2a52-4f8e-9a51-1d1d1f6e6e73";
  const homeId = "0d5c1f0a-7a43-4b6e-8f0e-2f6a0c9b1e55";

  it("holds the host id, the home id and the code", () => {
    const qr = { hostId, homeId, code: "K7QXM4PD" };
    const text = pairingQrText(qr);
    expect(text).toBe(
      `sanctum-pair:?v=3&host=${hostId}&home=${homeId}&code=K7QXM4PD`,
    );
    expect(parsePairingQr(text)).toEqual(qr);
  });

  it.each([
    "https://example.com/?host=a&code=K7QXM4PD",
    // Version 2, which carried the pin, and version 1, from before home ids.
    `sanctum-pair:?v=2&host=${hostId}&home=${homeId}&code=K7QXM4PD`,
    `sanctum-pair:?v=1&box=${hostId}&code=K7QXM4PD`,
    `sanctum-pair:?v=3&home=${homeId}&code=K7QXM4PD`,
    `sanctum-pair:?v=3&host=${hostId}&code=K7QXM4PD`,
    `sanctum-pair:?v=3&host=${hostId}&home=&code=K7QXM4PD`,
    `sanctum-pair:?v=3&host=${hostId}&home=${homeId}&code=K7QX0000`,
  ])("is not read from %j", (text) => {
    expect(parsePairingQr(text)).toBeNull();
  });
});

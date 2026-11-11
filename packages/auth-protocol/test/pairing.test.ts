import { describe, expect, it } from "vitest";

import {
  formatPairingCode,
  newPairingCode,
  normalisePairingCode,
  pairingCodeAlphabet,
  pairingQrText,
  parsePairingQr,
  shortPin,
} from "../src/index.js";

describe("display codes", () => {
  it("are eight characters without look-alikes", () => {
    for (let i = 0; i < 200; i += 1) {
      const code = newPairingCode();
      expect(code).toMatch(/^[2-9A-HJKMNP-TV-Z]{8}$/);
      expect(normalisePairingCode(code)).toBe(code);
    }
    expect(pairingCodeAlphabet).not.toMatch(/[01ILOU]/);
  });

  it("use every character of the alphabet", () => {
    const seen = new Set(
      Array.from({ length: 200 }, () => newPairingCode()).join(""),
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
  const pin = "hg6mmQxxksnFQb7m8qDqK0hT9z6lRb6vS8aW2b0FbUQ";

  it("holds the host id, the home id, the code and the pin", () => {
    const qr = { hostId, homeId, code: "K7QXM4PD", pin };
    const text = pairingQrText(qr);
    expect(text).toBe(
      `sanctum-pair:?v=2&host=${hostId}&home=${homeId}&code=K7QXM4PD&pin=${pin}`,
    );
    expect(parsePairingQr(text)).toEqual(qr);
  });

  it("has no pin over plain HTTP", () => {
    const text = pairingQrText({
      hostId,
      homeId,
      code: "K7QXM4PD",
      pin: null,
    });
    expect(text).not.toContain("pin");
    expect(parsePairingQr(text)).toEqual({
      hostId,
      homeId,
      code: "K7QXM4PD",
      pin: null,
    });
  });

  it.each([
    "https://example.com/?host=a&code=K7QXM4PD",
    `sanctum-pair:?v=3&host=${hostId}&home=${homeId}&code=K7QXM4PD`,
    // Version 1, from before home ids.
    `sanctum-pair:?v=1&box=${hostId}&code=K7QXM4PD`,
    `sanctum-pair:?v=2&home=${homeId}&code=K7QXM4PD`,
    `sanctum-pair:?v=2&host=${hostId}&code=K7QXM4PD`,
    `sanctum-pair:?v=2&host=${hostId}&home=&code=K7QXM4PD`,
    `sanctum-pair:?v=2&host=${hostId}&home=${homeId}&code=K7QX0000`,
    `sanctum-pair:?v=2&host=${hostId}&home=${homeId}&code=K7QXM4PD&pin=`,
    `sanctum-pair:?v=2&host=${hostId}&home=${homeId}&code=K7QXM4PD&pin=not-a-pin`,
  ])("is not read from %j", (text) => {
    expect(parsePairingQr(text)).toBeNull();
  });
});

describe("the short pin", () => {
  it("is the first 80 bits in five groups", () => {
    // The pin of shortPin's own example: SHA-256 bytes 86 0e a6 99 0c 71 92 c9
    // 15 41 …
    const pin = btoa(
      String.fromCharCode(
        0x86,
        0x0e,
        0xa6,
        0x99,
        0x0c,
        0x71,
        0x92,
        0xc9,
        0x15,
        0x41,
        ...Array<number>(22).fill(0xff),
      ),
    )
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(shortPin(pin)).toBe("860E-A699-0C71-92C9-1541");
  });
});

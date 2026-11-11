import { createHash, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { isPin, shortPin, spkiPin } from "../src/index.js";

describe("the host CA's pin", () => {
  it("is the SHA-256 of the public key's SubjectPublicKeyInfo, base64url", async () => {
    const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const spki = publicKey.export({ type: "spki", format: "der" });
    const pin = await spkiPin(new Uint8Array(spki));
    expect(pin).toBe(createHash("sha256").update(spki).digest("base64url"));
    expect(isPin(pin)).toBe(true);
    expect(shortPin(pin)).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){4}$/);
  });

  it.each(["", "short", `${"A".repeat(43)}=`, "+".repeat(43), 43])(
    "is not %j",
    (value) => expect(isPin(value)).toBe(false),
  );
});

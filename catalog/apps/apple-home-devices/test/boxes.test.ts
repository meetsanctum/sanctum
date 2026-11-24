import { describe, expect, it } from "vitest";

import {
  CodeExpired,
  errorOf,
  NotAllowed,
  PairingLost,
  Unreachable,
  WrongCode,
} from "../src/boxes.js";
import { kindOf, modelName } from "../src/models.js";

// The library's errors, which are plain messages, as the app's own, in the
// words node-appletv-remote 0.5.0 uses and those seen from the TVs.

describe("errorOf", () => {
  it.each([
    ["M4 missing Proof (error=2)", WrongCode],
    ["Companion PS M4 missing Proof (error=2)", WrongCode],
    ["Pair-verify M4 error: 2", PairingLost],
    ["Companion pair-verify M4 error: 2", PairingLost],
    [
      "Apple TV ended pairing: the PIN expired (it shows for about 35 seconds); start pairing again",
      CodeExpired,
    ],
    ["HTTP 470 from /pair-pin-start", NotAllowed],
    ["HTTP 403 from /pair-pin-start", NotAllowed],
    ["Companion PS timeout waiting for response frame", Unreachable],
  ])("reads %j", (message, kind) => {
    expect(errorOf(new Error(message))).toBeInstanceOf(kind);
  });

  it("reads a socket that can't connect as unreachable", () => {
    const error = Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    });
    expect(errorOf(error)).toBeInstanceOf(Unreachable);
  });

  it("leaves an error it doesn't know as it is", () => {
    const error = new Error("M4 missing Proof (error=6)");
    expect(errorOf(error)).toBe(error);
  });
});

describe("models", () => {
  it("tells Apple TVs and HomePods from other AirPlay devices", () => {
    expect(kindOf("AppleTV14,1")).toBe("tv");
    expect(kindOf("AppleTV5,3")).toBe("tv");
    expect(kindOf("AppleTV3,2")).toBeNull();
    expect(kindOf("AudioAccessory5,1")).toBe("homepod");
    expect(kindOf("Mac16,10")).toBeNull();
  });

  it("names models as Apple sells them", () => {
    expect(modelName("AppleTV6,2")).toBe("Apple TV 4K");
    expect(modelName("AppleTV99,1")).toBe("Apple TV");
    expect(modelName("AudioAccessory6,1")).toBe("HomePod (2nd generation)");
  });
});

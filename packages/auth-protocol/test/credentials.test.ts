import { describe, expect, it } from "vitest";

import {
  isUsername,
  normaliseUsername,
  passwordProblem,
} from "../src/index.js";

describe("usernames", () => {
  it("are lowercased and trimmed", () => {
    expect(normaliseUsername("  Maya.B ")).toBe("maya.b");
  });

  it.each(["maya", "maya_b", "m.b", "a".repeat(30), "ruth2"])(
    "accepts %s",
    (value) => expect(isUsername(value)).toBe(true),
  );

  it.each(["ma", "a".repeat(31), "maya b", "Maya", "mäya", "maya@home", ""])(
    "refuses %j",
    (value) => expect(isUsername(value)).toBe(false),
  );
});

describe("the password policy", () => {
  it("needs at least 8 characters", () => {
    expect(passwordProblem("seven77")).toBe("too_short");
    expect(passwordProblem("eight888")).toBeNull();
    // Characters, not bytes or UTF-16 units.
    expect(passwordProblem("🐝🐝🐝🐝🐝🐝🐝")).toBe("too_short");
  });

  it("allows at most 256 bytes after NFC normalisation", () => {
    expect(passwordProblem("a".repeat(256))).toBeNull();
    expect(passwordProblem("a".repeat(257))).toBe("too_long");
    // é as e + combining accent is 3 bytes, and 2 once composed.
    expect(passwordProblem("é".repeat(128))).toBeNull();
    expect(passwordProblem("é".repeat(129))).toBe("too_long");
  });
});

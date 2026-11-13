import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

// The settings the repository holds for the published site.

const file = join(import.meta.dirname, "..", ".env.production");

describe("the published site's settings", () => {
  it("are encrypted wherever the repository holds them", () => {
    if (!existsSync(file)) return;
    const lines = readFileSync(file, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    for (const line of lines) {
      const name = line.slice(0, line.indexOf("="));
      // Named alone, so a failure never prints a value.
      const kept =
        name.startsWith("DOTENV_PUBLIC_KEY") ||
        /^[A-Z0-9_]+="?encrypted:/.test(line);
      expect(kept ? "encrypted" : `${name} is in plain text`).toBe("encrypted");
    }
  });
});
